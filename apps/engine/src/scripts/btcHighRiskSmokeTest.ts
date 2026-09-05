import { fromDecimalJs } from "@trade-bot/shared";
import { Decimal } from "decimal.js";
import type { Candle } from "../broker/types";
import { fetchHistoricalFuturesCandles } from "../marketData/binanceFuturesPublic";
import { BTC_HIGH_RISK_AUX_TAG_4H, BtcHighRiskStrategy } from "../strategy/btcHighRisk";
import type { StrategyPositionState } from "../strategy/types";

// Standalone regression check for the BtcHighRiskStrategy port — no
// engine/Mongo/broker involved, just: fetch real historical futures
// candles, feed them through decide()/onAuxCandle() in true chronological
// order (merging the 1h and 4h streams by timestamp, so the algorithm
// never sees 4h context from before it actually happened), and report
// what it would have done. This is the "did the port actually work"
// check — typechecking only proves the code compiles, not that the ported
// pivot/Fib/session logic behaves anything like the verified Pine
// backtest. Run via: npx tsx src/scripts/btcHighRiskSmokeTest.ts
async function main(): Promise<void> {
  const symbol = "BTCUSDT";
  console.log(`[smoke] fetching historical futures candles for ${symbol}...`);
  // Binance's futures klines endpoint caps a single request at 1500 bars —
  // 1000 1h candles (~41 days) and 300 4h candles (~50 days) comfortably
  // covers enough real recent price action to exercise every rule
  // (pivots, min swing, 4h confirmation, session filter, both Fib levels)
  // without needing pagination.
  const candles1h = await fetchHistoricalFuturesCandles(symbol, "1h", 1000);
  const candles4h = await fetchHistoricalFuturesCandles(symbol, "4h", 300);
  console.log(`[smoke] got ${candles1h.length} 1h candles, ${candles4h.length} 4h candles`);

  type Tagged = { candle: Candle; kind: "1h" | "4h" };
  const merged: Tagged[] = [
    ...candles1h.map((candle): Tagged => ({ candle, kind: "1h" })),
    ...candles4h.map((candle): Tagged => ({ candle, kind: "4h" })),
  ].sort((a, b) => a.candle.closeTime.getTime() - b.candle.closeTime.getTime());

  const algorithm = new BtcHighRiskStrategy({ symbol, leverage: 100 });

  let position: StrategyPositionState = { isOpen: false, side: null, quantity: fromDecimalJs(new Decimal(0)) };
  let longEntries = 0;
  let shortEntries = 0;
  let stopExits = 0;
  let reversalExits = 0;
  let holdCount = 0;
  const trail: string[] = [];

  for (const { candle, kind } of merged) {
    if (kind === "4h") {
      algorithm.onAuxCandle(BTC_HIGH_RISK_AUX_TAG_4H, candle);
      continue;
    }

    const wasOpen = position.isOpen;
    const wasSide = position.side;
    const { signal, riskFraction } = algorithm.decide(candle, position);

    if (signal === "HOLD") {
      holdCount++;
      continue;
    }

    if (signal === "ENTER_LONG" || signal === "ENTER_SHORT") {
      const newSide = signal === "ENTER_LONG" ? "LONG" : "SHORT";
      if (wasOpen && wasSide !== newSide) {
        reversalExits++;
      }
      if (newSide === "LONG") {
        longEntries++;
      } else {
        shortEntries++;
      }
      position = { isOpen: true, side: newSide, quantity: toDecimal128Quantity() };
      trail.push(
        `${candle.closeTime.toISOString()}  ${signal}  risk=${((riskFraction ?? 0) * 100).toFixed(1)}%  close=${candle.close.toString()}`,
      );
    } else if (signal === "EXIT_LONG" || signal === "EXIT_SHORT") {
      stopExits++;
      position = { isOpen: false, side: null, quantity: fromDecimalJs(new Decimal(0)) };
      trail.push(`${candle.closeTime.toISOString()}  ${signal} (stop)  close=${candle.close.toString()}`);
    }
  }

  function toDecimal128Quantity() {
    return fromDecimalJs(new Decimal(1));
  }

  console.log("\n[smoke] === results ===");
  console.log(`1h candles processed: ${candles1h.length}, HOLD: ${holdCount}`);
  console.log(`Long entries: ${longEntries}`);
  console.log(`Short entries: ${shortEntries}`);
  console.log(`Reversal exits (flip while already in a position): ${reversalExits}`);
  console.log(`Stop-loss exits: ${stopExits}`);
  console.log(`Final position: ${position.isOpen ? position.side : "flat"}`);
  console.log("\n[smoke] last 15 signals:");
  for (const line of trail.slice(-15)) {
    console.log("  " + line);
  }

  const totalEntries = longEntries + shortEntries;
  if (totalEntries === 0) {
    console.error("\n[smoke] FAIL: zero entries over ~41 days of real data — something is almost certainly broken " +
      "(all-HOLD is the same failure shape as the original Pine port's inverted bar-index bug).");
    process.exitCode = 1;
    return;
  }
  console.log(`\n[smoke] OK: ${totalEntries} entries fired (${longEntries} long, ${shortEntries} short) — port looks live.`);
}

main().catch((error: unknown) => {
  console.error("[smoke] fatal error:", error);
  process.exitCode = 1;
});
