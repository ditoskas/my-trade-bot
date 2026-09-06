import { fromDecimalJs } from "@trade-bot/shared";
import { Decimal } from "decimal.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candle } from "../broker/types";
import { BinanceFuturesKlineStream } from "../marketData/binanceFuturesKlineStream";
import { fetchHistoricalFuturesCandles } from "../marketData/binanceFuturesPublic";
import { BTC_HIGH_RISK_AUX_TAG_4H, BtcHighRiskStrategy } from "../strategy/btcHighRisk";
import type { StrategyPositionState } from "../strategy/types";
import { warmUpAlgorithm, warmUpAuxCandles } from "../strategy/warmUp";

// Live-paper shadow observer for the btc-high-risk parity investigation
// (see strategies/btc-high-risk.md's "Engine port" section). The historical
// replay diagnostics (btcHighRiskSmokeTest.ts, btcHighRiskParityDiagnostic.ts)
// kept hitting the same confound: our fetched Binance klines and
// TradingView's own BTCUSDT.P feed occasionally disagree on exact intrabar
// highs/lows by a sub-1% margin, which a 100x-leverage strategy with exact
// `low <= fibX`/`high >= fibX` entry gates and a liquidation stop exactly 1%
// away is extremely sensitive to. Replaying more historical data can't
// distinguish "logic bug" from "feed disagreement" — only watching the SAME
// live feed the port would actually trade on, in real time, and comparing
// its signals against Pine's own live log.info output on the same real
// clock, can. This script is that observer. It is READ-ONLY: no Broker, no
// StrategyRunner, no order placement, no API keys — pure public market data
// (BinanceFuturesKlineStream connects to wss://fstream.binance.com, the
// real mainnet public futures stream, same as production would use for
// price data regardless of the BTC_HIGH_RISK_ALLOW_LIVE/testnet gate, which
// this script never touches or needs).
//
// Deliberately mirrors apps/engine/src/index.ts's startBtcHighRiskRuntime
// warm-up sizes (500 1h / 200 4h candles) rather than the deep multi-month
// warm-up the offline parity diagnostics used — the point here is observing
// exactly what production would actually see, not an idealized version of
// it.
//
// Run via: npx tsx src/scripts/btcHighRiskLiveShadow.ts
// (intended to be launched detached/long-running — see strategies/
// btc-high-risk.md for how to check on it later.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, "..", "..", "logs");
const LOG_FILE = join(LOG_DIR, "btc-high-risk-live-shadow.log");

function log(line: string): void {
  const withTimestamp = `[${new Date().toISOString()}] ${line}`;
  console.log(withTimestamp);
  try {
    appendFileSync(LOG_FILE, withTimestamp + "\n");
  } catch (error) {
    // Never let a logging failure take down the observer itself.
    console.error(`[shadow] failed to write log file: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  const symbol = "BTCUSDT";

  log(`[shadow] starting btc-high-risk live shadow observer for ${symbol} (read-only, no execution)`);

  // Same instantiation as production's real default (apps/engine/src/index.ts's
  // startBtcHighRiskRuntime): leverage 100, no minWick4hRatio override, so
  // iteration 15's wick filter runs at its true 0.5 default.
  const algorithm = new BtcHighRiskStrategy({ symbol, leverage: 100 });

  try {
    const history1h = await fetchHistoricalFuturesCandles(symbol, "1h", 500);
    warmUpAlgorithm(algorithm, history1h);
    const history4h = await fetchHistoricalFuturesCandles(symbol, "4h", 200);
    warmUpAuxCandles(algorithm, BTC_HIGH_RISK_AUX_TAG_4H, history4h);
    log(`[shadow] warmed up with ${history1h.length} 1h + ${history4h.length} 4h historical futures candles`);
  } catch (error) {
    log(`[shadow] WARNING: warm-up failed (${(error as Error).message}) — starting cold`);
  }

  let position: StrategyPositionState = { isOpen: false, side: null, quantity: fromDecimalJs(new Decimal(0)) };

  function handle1hCandle(candle: Candle): void {
    try {
      const { signal } = algorithm.decide(candle, position);
      const price = candle.close.toString();

      if (signal === "ENTER_LONG" || signal === "ENTER_SHORT") {
        const newSide = signal === "ENTER_LONG" ? "LONG" : "SHORT";
        log(`[shadow] SIGNAL ${signal} close=${price} candleOpen=${candle.openTime.toISOString()}`);
        position = { isOpen: true, side: newSide, quantity: fromDecimalJs(new Decimal(1)) };
      } else if (signal === "EXIT_LONG" || signal === "EXIT_SHORT") {
        log(`[shadow] SIGNAL ${signal} close=${price} candleOpen=${candle.openTime.toISOString()}`);
        position = { isOpen: false, side: null, quantity: fromDecimalJs(new Decimal(0)) };
      } else {
        // Heartbeat on every closed 1h candle even when nothing fires, so a
        // later read of the log can confirm the process was alive and
        // actually processing candles the whole time, not silently stalled
        // or disconnected.
        log(`[shadow] heartbeat HOLD close=${price} candleOpen=${candle.openTime.toISOString()} position=${position.isOpen ? position.side : "flat"}`);
      }
    } catch (error) {
      // A single bad tick must never crash this process — see
      // StrategyRunner.onCandle's comment on a real past incident where an
      // unhandled async rejection took the whole engine down. This
      // observer needs to keep running for days unattended.
      log(`[shadow] ERROR handling 1h candle: ${(error as Error).stack ?? (error as Error).message}`);
    }
  }

  function handle4hCandle(candle: Candle): void {
    try {
      algorithm.onAuxCandle?.(BTC_HIGH_RISK_AUX_TAG_4H, candle);
    } catch (error) {
      log(`[shadow] ERROR handling 4h candle: ${(error as Error).stack ?? (error as Error).message}`);
    }
  }

  const stream1h = new BinanceFuturesKlineStream({
    symbol,
    interval: "1h",
    onClosedCandle: handle1hCandle,
    onError: (error) => log(`[shadow] 1h stream error: ${error.message}`),
  });
  const stream4h = new BinanceFuturesKlineStream({
    symbol,
    interval: "4h",
    onClosedCandle: handle4hCandle,
    onError: (error) => log(`[shadow] 4h stream error: ${error.message}`),
  });

  stream1h.start();
  stream4h.start();
  log(`[shadow] 1h and 4h live futures streams started (wss://fstream.binance.com) — running indefinitely`);

  process.on("SIGINT", () => {
    log(`[shadow] SIGINT received, shutting down`);
    stream1h.stop();
    stream4h.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log(`[shadow] SIGTERM received, shutting down`);
    stream1h.stop();
    stream4h.stop();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  log(`[shadow] FATAL: ${(error as Error).stack ?? String(error)}`);
  process.exitCode = 1;
});
