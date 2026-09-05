import { Decimal } from "decimal.js";
import { toDecimalJs } from "@trade-bot/shared";
import type { Candle } from "../broker/types.js";
import type { StrategyAlgorithm, StrategyPositionState, StrategySignal } from "./types.js";

function average(values: Decimal[]): Decimal {
  return values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length);
}

// Trivial proof-of-pipeline strategy (see CLAUDE.md Phase 2): enters long on
// a fast-over-slow SMA crossover, exits on the cross back the other way.
// Not meant to be a good strategy — it exists to exercise decide() -> risk
// check -> capital reservation -> broker order -> Mongo end to end.
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
      if (fastAboveSlow && !position.isOpen) {
        signal = "ENTER_LONG";
      } else if (!fastAboveSlow && position.isOpen) {
        signal = "EXIT_LONG";
      }
    }
    this.wasFastAboveSlow = fastAboveSlow;
    return signal;
  }
}
