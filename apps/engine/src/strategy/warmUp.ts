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
