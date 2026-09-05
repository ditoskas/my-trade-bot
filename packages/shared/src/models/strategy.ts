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

// "binance" (spot) kept as its original name for backward compatibility with
// Phase 3's already-verified spot code; "binance-futures" is Phase 3b.
export type BrokerKind = "paper" | "binance" | "binance-futures";

export type MarginMode = "ISOLATED" | "CROSSED";

export interface RiskLimits {
  maxPositionSize: Decimal128;
  maxConcurrentPositions: number;
  maxDrawdownPct: number;
  // The strategy's configured leverage (1 for spot). RiskManager enforces
  // this against a hard system ceiling — see CLAUDE.md Phase 3b: leverage
  // is per-strategy configurable, not a single global limit, but a
  // misconfigured strategy still can't exceed the ceiling.
  maxLeverage: number;
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
  // Only meaningful for broker: "binance-futures" — Binance sets margin
  // mode per symbol, applied once when the strategy starts (see
  // BinanceFuturesBroker.configureSymbol).
  marginMode?: MarginMode;
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
