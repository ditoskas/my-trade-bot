import type { Decimal128, ObjectId } from "mongodb";

// Strategies are promoted through these states deliberately, never straight
// to live_full — see CLAUDE.md "Non-negotiable policies".
export type StrategyLifecycleState =
  | "draft"
  | "backtested"
  | "paper"
  | "live_small"
  | "live_full"
  | "paused"
  | "retired";

export type BrokerKind = "paper" | "binance";

export interface RiskLimits {
  maxPositionSize: Decimal128;
  maxConcurrentPositions: number;
  maxDrawdownPct: number;
}

export interface Strategy {
  _id: ObjectId;
  slug: string;
  name: string;
  description?: string;
  // Bumped whenever the strategy's logic/parameters change, so trades stay
  // attributable to the version that produced them (see CLAUDE.md Phase 2).
  version: number;
  lifecycleState: StrategyLifecycleState;
  broker: BrokerKind;
  symbols: string[];
  allocatedCapital: Decimal128;
  allocatedCapitalAsset: string;
  riskLimits: RiskLimits;
  config: Record<string, unknown>;
  killSwitchEngaged: boolean;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  stoppedAt?: Date;
}
