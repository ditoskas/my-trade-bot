import type { ObjectId } from "mongodb";

export type AuditEventType =
  | "DECISION"
  | "ORDER_INTENT"
  | "ORDER_SUBMITTED"
  | "ORDER_FILLED"
  | "RISK_BLOCK"
  | "KILL_SWITCH"
  | "RECONCILIATION_MISMATCH"
  | "COMMAND";

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
