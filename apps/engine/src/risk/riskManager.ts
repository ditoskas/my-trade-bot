import type { Strategy } from "@trade-bot/shared";

export class RiskBlockedError extends Error {}

// Default backstop for RiskManager's hard leverage ceiling — see the
// constructor comment below for why this exists alongside per-strategy
// configurable leverage.
const DEFAULT_HARD_MAX_LEVERAGE = 20;

// Enforced centrally, outside strategy code, so a bug in a strategy (or a
// bad config value) can't override its own risk limits (see CLAUDE.md's
// Risk Manager section). maxConcurrentPositions/maxDrawdownPct enforcement,
// and any live margin-ratio/liquidation-price monitoring, are deferred to
// Phase 6 hardening — this covers kill switch, lifecycle state, and a
// leverage ceiling.
export class RiskManager {
  private readonly hardMaxLeverage: number;

  // Leverage is configurable per strategy (CLAUDE.md Phase 3b — the user's
  // call, not a fixed system value), but a misconfigured strategy document
  // still shouldn't be able to run at arbitrary leverage. hardMaxLeverage
  // is the ceiling no strategy's own configured maxLeverage may exceed,
  // regardless of what its config says.
  constructor(hardMaxLeverage: number = DEFAULT_HARD_MAX_LEVERAGE) {
    this.hardMaxLeverage = hardMaxLeverage;
  }

  checkCanEnter(strategy: Strategy): void {
    if (strategy.killSwitchEngaged) {
      throw new RiskBlockedError(`strategy ${strategy.slug}: kill switch engaged`);
    }
    if (strategy.lifecycleState === "paused" || strategy.lifecycleState === "retired") {
      throw new RiskBlockedError(`strategy ${strategy.slug}: lifecycle state is ${strategy.lifecycleState}`);
    }
    if (strategy.riskLimits.maxLeverage > this.hardMaxLeverage) {
      throw new RiskBlockedError(
        `strategy ${strategy.slug}: configured leverage ${strategy.riskLimits.maxLeverage}x exceeds the hard ceiling of ${this.hardMaxLeverage}x`,
      );
    }
  }
}
