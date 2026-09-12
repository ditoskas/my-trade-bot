import { toDecimal128, fromDecimalJs } from "@trade-bot/shared";
import { Decimal } from "decimal.js";
import type { Candle } from "../broker/types";
import { BTC_HIGH_RISK_AUX_TAG_4H, BtcHighRiskStrategy, type BtcHighRiskDebugState } from "../strategy/btcHighRisk";
import type { StrategyPositionState } from "../strategy/types";

// "Why did btc-high-risk do nothing?" diagnostic.
//
// The dashboard's decision tab reads audit_log, and StrategyRunner only
// writes a DECISION entry on a NON-HOLD signal — so a whole day of the
// strategy correctly deciding "no setup here" produces an empty tab that
// looks identical to a dead feed. This script closes that gap offline:
// it replays the same public 1h + 4h futures candles the live poller
// feeds the engine, through the same BtcHighRiskStrategy with the same
// production config, and prints the per-bar decision state plus the
// FIRST condition that blocked an entry on each bar.
//
// Read-only: public Binance REST market data only, no keys, no Mongo, no
// orders. Safe to run at any time, including against production hours.
//
// Run via:
//   npm run btc-why-hold --workspace=@trade-bot/engine            # last 48h
//   npm run btc-why-hold --workspace=@trade-bot/engine -- 2026-09-10
//   npm run btc-why-hold --workspace=@trade-bot/engine -- 2026-09-10 2026-09-11

const SYMBOL = "BTCUSDT";
const LEVERAGE = 100; // matches BTC_HIGH_RISK_LEVERAGE in index.ts
const WARMUP_DAYS = 30; // enough bars for pivots/swings/4h trend to be established

async function fetchRange(symbol: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  for (;;) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1500`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance futures klines request failed: ${response.status} ${response.statusText}`);
    }
    const rows = (await response.json()) as [number, string, string, string, string, string, number, ...unknown[]][];
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      out.push({
        symbol,
        openTime: new Date(row[0]),
        closeTime: new Date(row[6]),
        open: toDecimal128(row[1]),
        high: toDecimal128(row[2]),
        low: toDecimal128(row[3]),
        close: toDecimal128(row[4]),
        volume: toDecimal128(row[5]),
      });
    }
    const lastCloseTime = out[out.length - 1]!.closeTime.getTime();
    if (lastCloseTime >= endMs) {
      break;
    }
    cursor = lastCloseTime + 1;
  }
  return out;
}

// The first gate, in the order decide() itself evaluates them, that kept
// this bar from producing an entry. Naming ONE reason (rather than
// dumping every field) is the point: it turns "nothing happened" into
// "nothing happened because X", which is what you actually need to know.
//
// The gate order below mirrors decide()'s real control flow: swing
// validity first, then the isBullishConfirmed/isBearishConfirmed
// conjunction (trend4h alignment + validZone4h + inNightSession +
// validWick4h + the candle pattern itself), and only then the fib-band
// lookup — fibBandTouched stays null when confirmation failed, because
// the block that assigns it never runs.
function blockingReason(d: BtcHighRiskDebugState): string {
  if (d.signal !== "HOLD") {
    return `signal ${d.signal}`;
  }
  if (!d.hasSwing) {
    return "no 1h swing detected yet (no confirmed pivot high+low)";
  }
  if (d.validSwing === false) {
    return `swing too small (${d.swingPct?.toFixed(2)}% < minSwingPct)`;
  }
  if (d.trend4h === 0) {
    return "4h trend undecided (no directional bias to trade with)";
  }
  if (d.validZone4h === false) {
    return `4h fib zone too narrow (width ${d.zoneWidth4h} < minZoneWidth)`;
  }
  if (!d.validWick4h) {
    return `4h wick ratio ${d.wick4hRatio} below minWick4hRatio`;
  }
  if (d.inNightSession === false) {
    return "outside the configured trading session hours";
  }
  if (!d.isBullishConfirmed && !d.isBearishConfirmed) {
    return "no confirmed bullish/bearish candle pattern aligned with the 4h trend";
  }
  // Confirmed direction, so decide() did reach the band lookup.
  if (d.fibBandTouched === "none") {
    return "confirmed setup, but price never reached any fib retracement band";
  }
  if (d.fibBandTouched === "382" || d.fibBandTouched === "618") {
    return (
      `confirmed setup at the ${d.fibBandTouched === "382" ? "38.2" : "61.8"}% band, which is ` +
      "deliberately non-tradeable (iterations 13-14 dropped it; only 50.0% and 78.6% enter)"
    );
  }
  return "all named gates passed — read the full state line below";
}

function parseDay(arg: string): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(arg);
  if (!match) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${arg}"`);
  }
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return { start, end: start + 86_400_000 };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let windowStart: number;
  let windowEnd: number;
  if (args.length === 0) {
    windowEnd = Date.now();
    windowStart = windowEnd - 48 * 3_600_000;
  } else if (args.length === 1) {
    ({ start: windowStart, end: windowEnd } = parseDay(args[0]!));
  } else {
    windowStart = parseDay(args[0]!).start;
    windowEnd = parseDay(args[1]!).end;
  }

  const fetchStart = windowStart - WARMUP_DAYS * 86_400_000;
  console.error(
    `[why-hold] window ${new Date(windowStart).toISOString()} -> ${new Date(windowEnd).toISOString()} ` +
      `(+${WARMUP_DAYS}d warm-up), fetching candles...`,
  );
  const candles1h = await fetchRange(SYMBOL, "1h", fetchStart, windowEnd);
  const candles4h = await fetchRange(SYMBOL, "4h", fetchStart, windowEnd);
  console.error(`[why-hold] got ${candles1h.length} 1h candles, ${candles4h.length} 4h candles`);

  type Tagged = { candle: Candle; kind: "1h" | "4h" };
  const merged: Tagged[] = [
    ...candles1h.map((candle): Tagged => ({ candle, kind: "1h" })),
    ...candles4h.map((candle): Tagged => ({ candle, kind: "4h" })),
  ].sort((a, b) => a.candle.closeTime.getTime() - b.candle.closeTime.getTime());

  // Production config — deliberately NOT the parity script's
  // minWick4hRatio: 0 override. This has to be exactly what the live
  // engine runs, or the answer describes a different strategy than the
  // one being debugged.
  const algorithm = new BtcHighRiskStrategy({ symbol: SYMBOL, leverage: LEVERAGE });

  let position: StrategyPositionState = { isOpen: false, side: null, quantity: fromDecimalJs(new Decimal(0)) };
  let barsInWindow = 0;
  let signalsInWindow = 0;
  const reasonCounts = new Map<string, number>();

  for (const { candle, kind } of merged) {
    if (kind === "4h") {
      algorithm.onAuxCandle(BTC_HIGH_RISK_AUX_TAG_4H, candle);
      continue;
    }
    const { signal } = algorithm.decide(candle, position);
    const debug = algorithm.lastDebugState;

    if (signal === "ENTER_LONG" || signal === "ENTER_SHORT") {
      position = {
        isOpen: true,
        side: signal === "ENTER_LONG" ? "LONG" : "SHORT",
        quantity: fromDecimalJs(new Decimal(0)),
      };
    } else if (signal === "EXIT_LONG" || signal === "EXIT_SHORT") {
      position = { isOpen: false, side: null, quantity: fromDecimalJs(new Decimal(0)) };
    }

    const openMs = candle.openTime.getTime();
    if (openMs < windowStart || openMs >= windowEnd || !debug) {
      continue;
    }
    barsInWindow += 1;
    if (signal !== "HOLD") {
      signalsInWindow += 1;
    }
    const reason = blockingReason(debug);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);

    console.log(
      `${candle.openTime.toISOString()}  close=${candle.close.toString().padStart(10)}  ` +
        `${signal.padEnd(12)} ${reason}`,
    );
    console.log(
      `    dir1h=${debug.direction1h} swing=${debug.swingPct?.toFixed(2) ?? "-"}% ` +
        `trend4h=${debug.trend4h} zone4h=${debug.validZone4h} wick4h=${debug.wick4hRatio ?? "-"} ` +
        `session=${debug.inNightSession} band=${debug.fibBandTouched} ` +
        `bull=${debug.isBullishConfirmed} bear=${debug.isBearishConfirmed}`,
    );
  }

  console.log(`\n=== Summary ===`);
  console.log(`1h bars in window: ${barsInWindow}`);
  console.log(`Non-HOLD signals:  ${signalsInWindow}`);
  console.log(`\nBlocking reasons, most common first:`);
  for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}x  ${reason}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
