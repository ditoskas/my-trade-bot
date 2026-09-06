import { toDecimal128, fromDecimalJs } from "@trade-bot/shared";
import { Decimal } from "decimal.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Candle } from "../broker/types";
import { BTC_HIGH_RISK_AUX_TAG_4H, BtcHighRiskStrategy, type BtcHighRiskDebugState } from "../strategy/btcHighRisk";
import type { StrategyPositionState } from "../strategy/types";

// Diagnostic for the specific 9-missed/10-extra residual gap recorded in
// strategies/btc-high-risk.md ("Engine port" — the 87.7% parity re-check).
// Unlike btcHighRiskSmokeTest.ts (a pass/fail sanity check), this script's
// whole point is to name the exact divergent trades and print the port's
// full decision state at each — the "diagnose those specific remaining
// divergent cases directly" step the doc calls for next. Real Pine trade
// list lives in fixtures/btcHighRiskIteration14Trades.json — all 74 real
// trades (direction + entry time, UTC) read directly off the Strategy
// Tester's "List of trades" panel for the BTC High-Risk strategy with
// minWick4hRatio set to 0 (neutralizing iteration 15's filter, matching
// the iteration-14 baseline the original parity numbers were measured
// against), Jan 1 - Sep 6, 2026 — not a re-derived/scraped guess, hand
// transcribed one screen at a time via browser automation since this
// account's plan doesn't allow CSV export of the trade list. Run via:
//   npx tsx src/scripts/btcHighRiskParityDiagnostic.ts

const __dirname = dirname(fileURLToPath(import.meta.url));

type RealTrade = { direction: 1 | -1; entryTimeMs: number };

function loadRealTrades(): RealTrade[] {
  const raw = readFileSync(join(__dirname, "fixtures", "btcHighRiskIteration14Trades.json"), "utf-8");
  const rows = JSON.parse(raw) as [1 | -1, number][];
  return rows.map(([direction, entryTimeMs]) => ({ direction, entryTimeMs })).sort((a, b) => a.entryTimeMs - b.entryTimeMs);
}

// Binance futures klines cap a single request at 1500 bars — paginate by
// startTime to cover the full Jan 1 - now, 2026 range the real parity
// re-check used (see strategies/btc-high-risk.md: TradingView's 1h history
// for this symbol only reaches back to ~Jan 2026, so both sides used that
// as the warm-up start rather than the original 2025 dates).
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
    const lastCloseTime = rows[rows.length - 1][6];
    if (lastCloseTime >= endMs || rows.length < 1500) {
      break;
    }
    cursor = lastCloseTime + 1;
  }
  return out;
}

type PortEntry = { direction: 1 | -1; timeMs: number; debug: BtcHighRiskDebugState };

async function main(): Promise<void> {
  const symbol = "BTCUSDT";
  const start = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01, matches the doc's re-check warm-up start
  const end = Date.now();

  console.error(`[diag] fetching 1h candles ${new Date(start).toISOString()} -> ${new Date(end).toISOString()}...`);
  const candles1h = await fetchRange(symbol, "1h", start, end);
  console.error(`[diag] fetching 4h candles...`);
  const candles4h = await fetchRange(symbol, "4h", start, end);
  console.error(`[diag] got ${candles1h.length} 1h candles, ${candles4h.length} 4h candles`);

  type Tagged = { candle: Candle; kind: "1h" | "4h" };
  const merged: Tagged[] = [
    ...candles1h.map((candle): Tagged => ({ candle, kind: "1h" })),
    ...candles4h.map((candle): Tagged => ({ candle, kind: "4h" })),
  ].sort((a, b) => a.candle.closeTime.getTime() - b.candle.closeTime.getTime());

  // minWick4hRatio: 0 neutralizes iteration 15's filter — same
  // apples-to-apples-against-iteration-14-baseline methodology the 87.7%
  // re-check used.
  const algorithm = new BtcHighRiskStrategy({ symbol, leverage: 100, minWick4hRatio: 0 });

  let position: StrategyPositionState = { isOpen: false, side: null, quantity: fromDecimalJs(new Decimal(0)) };
  const portEntries: PortEntry[] = [];
  const barLog = new Map<number, BtcHighRiskDebugState>(); // closeTime ms -> debug state, every 1h bar

  for (const { candle, kind } of merged) {
    if (kind === "4h") {
      algorithm.onAuxCandle(BTC_HIGH_RISK_AUX_TAG_4H, candle);
      continue;
    }
    const wasOpen = position.isOpen;
    const wasSide = position.side;
    const { signal, riskFraction } = algorithm.decide(candle, position);
    const debug = algorithm.lastDebugState;
    if (debug) {
      // Keyed by the same fill-time convention as portEntries/realTrades
      // (openTime + 1h) so a lookup by a real trade's entry time lands on
      // the bar that actually produced (or failed to produce) that signal.
      barLog.set(candle.openTime.getTime() + 3_600_000, debug);
    }

    if (signal === "ENTER_LONG" || signal === "ENTER_SHORT") {
      const newSide = signal === "ENTER_LONG" ? "LONG" : "SHORT";
      // Fill-time semantics, not raw closeTime: Binance klines report
      // closeTime as openTime + interval - 1ms (e.g. an hourly candle
      // opening 23:00 closes 23:59:59.999), but Pine's strategy.entry()
      // (default process_orders_on_close=false) fills at the NEXT bar's
      // OPEN -- one hour after this candle's open, not "the same hour"
      // closeTime would naively suggest. Using openTime+1h here is what
      // makes a genuinely-matching signal compare as a true exact match
      // instead of a spurious ~1ms-driven "off-by-1h".
      portEntries.push({
        direction: newSide === "LONG" ? 1 : -1,
        timeMs: candle.openTime.getTime() + 3_600_000,
        debug: debug!,
      });
      position = { isOpen: true, side: newSide, quantity: fromDecimalJs(new Decimal(0)) };
      void riskFraction;
    } else if (signal === "EXIT_LONG" || signal === "EXIT_SHORT") {
      position = { isOpen: false, side: null, quantity: fromDecimalJs(new Decimal(0)) };
    } else if (wasOpen && wasSide !== position.side) {
      // unreachable given current signal set, kept for clarity
    }
  }

  const realTrades = loadRealTrades();
  console.error(`[diag] ${realTrades.length} real trades, ${portEntries.length} port entries`);

  const HOUR = 3_600_000;
  const usedPortIdx = new Set<number>();
  type Match = { real: RealTrade; port: PortEntry | null; kind: "exact" | "off-by-1h" | "missed" };
  const matches: Match[] = [];

  for (const real of realTrades) {
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < portEntries.length; i++) {
      if (usedPortIdx.has(i)) continue;
      const p = portEntries[i];
      if (p.direction !== real.direction) continue;
      const delta = Math.abs(p.timeMs - real.entryTimeMs);
      if (delta <= HOUR && delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      usedPortIdx.add(bestIdx);
      matches.push({ real, port: portEntries[bestIdx], kind: bestDelta === 0 ? "exact" : "off-by-1h" });
    } else {
      matches.push({ real, port: null, kind: "missed" });
    }
  }

  const extraPortEntries = portEntries.filter((_, i) => !usedPortIdx.has(i));
  const exact = matches.filter((m) => m.kind === "exact");
  const offByOne = matches.filter((m) => m.kind === "off-by-1h");
  const missed = matches.filter((m) => m.kind === "missed");

  console.log("\n=== Summary ===");
  console.log(`Real trades: ${realTrades.length}, Port entries: ${portEntries.length}`);
  console.log(`Exact matches: ${exact.length}`);
  console.log(`Off-by-1h matches: ${offByOne.length}`);
  console.log(`Missed (no port entry within 1h, same direction): ${missed.length}`);
  console.log(`Extra port-only entries: ${extraPortEntries.length}`);

  function fmtState(d: BtcHighRiskDebugState): string {
    return [
      `  time=${d.barTimeIso}`,
      `  signal=${d.signal}`,
      `  hasSwing=${d.hasSwing} dir1h=${d.direction1h} validSwing=${d.validSwing} swingPct=${d.swingPct?.toFixed(3)}`,
      `  high1h=${d.lastHigh1h}@${d.lastHighBar1h} low1h=${d.lastLow1h}@${d.lastLowBar1h}`,
      `  fib382=${d.fib382} fib500=${d.fib500} fib618=${d.fib618} fib786=${d.fib786} bandTouched=${d.fibBandTouched}`,
      `  trend4h=${d.trend4h} zoneWidth4h=${d.zoneWidth4h} validZone4h=${d.validZone4h}`,
      `  wick4hRatio=${d.wick4hRatio} validWick4h=${d.validWick4h}`,
      `  inNightSession=${d.inNightSession}`,
      `  isBullishConfirmed=${d.isBullishConfirmed} isBearishConfirmed=${d.isBearishConfirmed}`,
    ].join("\n");
  }

  console.log("\n=== MISSED real trades (port never fired within 1h, same direction) ===");
  for (const m of missed) {
    const real = m.real;
    const t = new Date(real.entryTimeMs);
    console.log(`\n--- Real ${real.direction === 1 ? "LONG" : "SHORT"} @ ${t.toISOString()} ---`);
    // Port's own decision state for the 1h candle whose closeTime equals
    // the real trade's entry time (Pine fills at the next bar's open,
    // i.e. the prior bar's close -- see script comment above) -- this is
    // exactly what the port was "thinking" at the moment Pine entered.
    const state = barLog.get(real.entryTimeMs);
    if (state) {
      console.log(fmtState(state));
    } else {
      console.log(`  (no port bar log exactly at this timestamp -- checking +/-1h)`);
      const before = barLog.get(real.entryTimeMs - HOUR);
      const after = barLog.get(real.entryTimeMs + HOUR);
      if (before) console.log("  [t-1h]\n" + fmtState(before));
      if (after) console.log("  [t+1h]\n" + fmtState(after));
    }
  }

  console.log("\n\n=== EXTRA port-only entries (no real trade within 1h, same direction) ===");
  for (const p of extraPortEntries) {
    console.log(`\n--- Port ${p.direction === 1 ? "LONG" : "SHORT"} @ ${new Date(p.timeMs).toISOString()} ---`);
    console.log(fmtState(p.debug));
  }

  console.log("\n\n=== OFF-BY-1H matches (for completeness) ===");
  for (const m of offByOne) {
    console.log(
      `Real ${m.real.direction === 1 ? "LONG" : "SHORT"} @ ${new Date(m.real.entryTimeMs).toISOString()} <-> ` +
        `Port @ ${new Date(m.port!.timeMs).toISOString()}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error("[diag] fatal error:", error);
  process.exitCode = 1;
});
