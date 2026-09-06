import type { Decimal128 } from "mongodb";
import type { Candle } from "../broker/types";

// SHORT support added in Phase 3b (futures) — spot couldn't short, so
// ENTER_LONG/EXIT_LONG were the whole set before that.
export type StrategySignal = "ENTER_LONG" | "EXIT_LONG" | "ENTER_SHORT" | "EXIT_SHORT" | "HOLD";

export interface StrategyPositionState {
  isOpen: boolean;
  side: "LONG" | "SHORT" | null;
  quantity: Decimal128;
}

// riskFraction is only meaningful alongside ENTER_LONG/ENTER_SHORT — the
// fraction (0-1] of the strategy's free capital to reserve as margin for
// this entry. Added porting btc-high-risk (see strategy/btcHighRisk.ts),
// whose position sizing varies per Fib level (0.5%-2% of equity) rather
// than "use everything," which is all StrategyRunner supported before.
// Undefined means "use all free capital," preserving MovingAverageCrossStrategy's
// original behavior unchanged.
export interface StrategyDecision {
  signal: StrategySignal;
  riskFraction?: number;
  // Only meaningful alongside ENTER_LONG/ENTER_SHORT when a position is
  // already open on that SAME side. Ordinarily StrategyRunner treats that
  // as "stay put, nothing to do" (the common case: an algorithm's entry
  // condition often stays true every bar while already in the position it
  // describes, and re-placing an order each time would just churn fees).
  // Set this true to force an explicit close-then-reopen instead — needed
  // when an algorithm's OWN exit fired earlier in this same decide() call
  // (e.g. a stop-loss) and it then wants to re-enter in that same
  // direction on the very same bar, which a bare ENTER_LONG/ENTER_SHORT
  // can't distinguish from "no change" once StrategyRunner's own
  // bookkeeping still shows a position open. See btc-high-risk.ts's
  // decide() for the motivating case (Pine's independent exit/entry blocks
  // both evaluate every bar; a single decide() call returning one signal
  // couldn't express that without this). Undefined/false preserves every
  // existing strategy's behavior unchanged.
  forceReenter?: boolean;
}

// Deliberately named StrategyAlgorithm, not Strategy — @trade-bot/shared's
// Strategy type is the Mongo document (config/lifecycle/capital); this is
// the pluggable decision logic a strategy document points at. One position
// per symbol at a time (matches the one-way position mode decision in
// CLAUDE.md Phase 3b) — a strategy is flat, long, or short, never both.
export interface StrategyAlgorithm {
  readonly slug: string;
  readonly symbol: string;
  decide(candle: Candle, position: StrategyPositionState): StrategyDecision;
  // Optional hook for a secondary timeframe's closed candles (e.g.
  // btc-high-risk's 4h trend/zone confirmation via request.security in the
  // original Pine script). `tag` identifies which auxiliary feed this is
  // when a strategy subscribes to more than one — the interval string
  // (e.g. "240") is a reasonable default. Most strategies (e.g. the MA
  // cross demo) only ever look at their primary candle stream and can
  // leave this unimplemented.
  onAuxCandle?(tag: string, candle: Candle): void;
}
