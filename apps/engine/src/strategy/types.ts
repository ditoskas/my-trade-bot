import type { Decimal128 } from "mongodb";
import type { Candle } from "../broker/types.js";

// SHORT support added in Phase 3b (futures) — spot couldn't short, so
// ENTER_LONG/EXIT_LONG were the whole set before that.
export type StrategySignal = "ENTER_LONG" | "EXIT_LONG" | "ENTER_SHORT" | "EXIT_SHORT" | "HOLD";

export interface StrategyPositionState {
  isOpen: boolean;
  side: "LONG" | "SHORT" | null;
  quantity: Decimal128;
}

// Deliberately named StrategyAlgorithm, not Strategy — @trade-bot/shared's
// Strategy type is the Mongo document (config/lifecycle/capital); this is
// the pluggable decision logic a strategy document points at. One position
// per symbol at a time (matches the one-way position mode decision in
// CLAUDE.md Phase 3b) — a strategy is flat, long, or short, never both.
export interface StrategyAlgorithm {
  readonly slug: string;
  readonly symbol: string;
  decide(candle: Candle, position: StrategyPositionState): StrategySignal;
}
