import type { Strategy } from "@trade-bot/shared";

export class RiskBlockedError extends Error {}

// Enforced centrally, outside strategy code, so a bug in a strategy can't
// override its own risk limits (see CLAUDE.md's Risk Manager section).
// maxConcurrentPositions/maxDrawdownPct enforcement is deferred to Phase 6
// hardening — this covers the two checks that matter even for one paper
// strategy: the kill switch and the lifecycle state.
export class RiskManager {
  checkCanEnter(strategy: Strategy): void {
    if (strategy.killSwitchEngaged) {
      throw new RiskBlockedError(`strategy ${strategy.slug}: kill switch engaged`);
    }
    if (strategy.lifecycleState === "paused" || strategy.lifecycleState === "retired") {
      throw new RiskBlockedError(`strategy ${strategy.slug}: lifecycle state is ${strategy.lifecycleState}`);
    }
  }
}
