import type { Decimal128 } from "mongodb";
import type { Candle } from "../broker/types.js";

export type StrategySignal = "ENTER_LONG" | "EXIT_LONG" | "HOLD";

export interface StrategyPositionState {
  isOpen: boolean;
  quantity: Decimal128;
}

// Deliberately named StrategyAlgorithm, not Strategy — @trade-bot/shared's
// Strategy type is the Mongo document (config/lifecycle/capital); this is
// the pluggable decision logic a strategy document points at. Spot-only for
// now: no SHORT signal, since spot can't short — see CLAUDE.md Phase 3 for
// where margin/futures would change this.
export interface StrategyAlgorithm {
  readonly slug: string;
  readonly symbol: string;
  decide(candle: Candle, position: StrategyPositionState): StrategySignal;
}
