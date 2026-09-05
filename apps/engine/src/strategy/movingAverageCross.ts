import { Decimal } from "decimal.js";
import { toDecimalJs } from "@trade-bot/shared";
import type { Candle } from "../broker/types.js";
import type { StrategyAlgorithm, StrategyPositionState, StrategySignal } from "./types.js";

function average(values: Decimal[]): Decimal {
  return values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length);
}

// Trivial proof-of-pipeline strategy (see CLAUDE.md Phase 2/3b): goes long
// on a fast-over-slow SMA crossover, short on the cross back the other way.
// Not meant to be a good strategy — it exists to exercise decide() -> risk
// check -> capital reservation -> broker order -> Mongo end to end.
//
// ENTER_LONG/ENTER_SHORT mean "be long/short after this," which — since
// crosses alternate direction — StrategyRunner treats as a flip (exit then
// re-enter) when the current position is the opposite side, not just "open
// from flat." An earlier version returned EXIT_LONG/EXIT_SHORT instead on a
// reversing cross, which meant SHORT was structurally unreachable: exiting
// a LONG only ever happened on a cross-down, and the next cross is always
// up, so the algorithm could never be flat exactly when a cross-down
// occurred. EXIT_LONG/EXIT_SHORT are left in StrategySignal for a future
// strategy that wants to flatten without reversing (e.g. a stop-loss).
export class MovingAverageCrossStrategy implements StrategyAlgorithm {
  readonly slug = "ma-cross-demo";
  readonly symbol: string;

  private readonly fastPeriod: number;
  private readonly slowPeriod: number;
  private readonly closes: Decimal[] = [];
  private wasFastAboveSlow: boolean | null = null;

  constructor(symbol: string, fastPeriod = 5, slowPeriod = 20) {
    this.symbol = symbol;
    this.fastPeriod = fastPeriod;
    this.slowPeriod = slowPeriod;
  }

  decide(candle: Candle, position: StrategyPositionState): StrategySignal {
    this.closes.push(toDecimalJs(candle.close));
    if (this.closes.length > this.slowPeriod) {
      this.closes.shift();
    }
    if (this.closes.length < this.slowPeriod) {
      return "HOLD";
    }

    const fast = average(this.closes.slice(-this.fastPeriod));
    const slow = average(this.closes);
    const fastAboveSlow = fast.greaterThan(slow);

    let signal: StrategySignal = "HOLD";
    if (this.wasFastAboveSlow !== null && fastAboveSlow !== this.wasFastAboveSlow) {
      if (fastAboveSlow && position.side !== "LONG") {
        signal = "ENTER_LONG";
      } else if (!fastAboveSlow && position.side !== "SHORT") {
        signal = "ENTER_SHORT";
      }
    }
    this.wasFastAboveSlow = fastAboveSlow;
    return signal;
  }
}
