import { fromDecimalJs } from "@trade-bot/shared";
import { Decimal } from "decimal.js";
import type { Candle } from "../broker/types";
import type { StrategyAlgorithm } from "./types";

// Feeds historical candles into an algorithm's decide() purely to prime any
// internal rolling state (e.g. a moving-average window) before live data
// starts — without this, a strategy with a 20-period SMA would sit idle
// for 20 live candles after every engine restart before it could possibly
// signal anything. Signals returned during warm-up are discarded; nothing
// is ever open at this point (isOpen: false), matching engine startup.
export function warmUpAlgorithm(algorithm: StrategyAlgorithm, historicalCandles: Candle[]): void {
  for (const candle of historicalCandles) {
    algorithm.decide(candle, { isOpen: false, side: null, quantity: fromDecimalJs(new Decimal(0)) });
  }
}

// Same idea as warmUpAlgorithm, but for a strategy's auxiliary timeframe
// (see StrategyAlgorithm.onAuxCandle) — e.g. btc-high-risk's 4h trend/zone
// state needs its own history before the 1h feed can trust it.
export function warmUpAuxCandles(algorithm: StrategyAlgorithm, tag: string, historicalCandles: Candle[]): void {
  if (!algorithm.onAuxCandle) {
    return;
  }
  for (const candle of historicalCandles) {
    algorithm.onAuxCandle(tag, candle);
  }
}
