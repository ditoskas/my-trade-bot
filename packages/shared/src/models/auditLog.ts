import type { ObjectId } from "mongodb";

export type AuditEventType =
  | "DECISION"
  | "ORDER_INTENT"
  | "ORDER_SUBMITTED"
  | "ORDER_FILLED"
  | "RISK_BLOCK"
  | "KILL_SWITCH"
  | "RECONCILIATION_MISMATCH"
  | "COMMAND"
  // A real open position was found on the exchange when a strategy's
  // runner started up (see StrategyRunner.initialize) — position tracking
  // is in-memory only, so this happens whenever the engine restarts while
  // a position is open. Distinct from RISK_BLOCK: nothing was blocked,
  // this is recording that in-memory state was resynced to reality.
  | "POSITION_RECOVERED"
  // A strategy's runner/market-data connections were started or stopped at
  // runtime via the dashboard's enable/disable control (see index.ts's
  // enableStrategy/disableStrategy) — distinct from pause/resume, which
  // only blocks new entries while the runner keeps running.
  | "ENABLED"
  | "DISABLED";

export type AuditSource = "engine" | "chatops" | "ui";

// Immutable log of every decision/order/risk event — never updated or
// deleted, since this is the record used to reconstruct "why did it place
// this trade" and for tax/accounting review.
export interface AuditLogEntry {
  _id: ObjectId;
  strategyId: ObjectId | null;
  eventType: AuditEventType;
  source: AuditSource;
  payload: Record<string, unknown>;
  timestamp: Date;
}
