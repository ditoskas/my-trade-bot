import type { Decimal128, ObjectId } from "mongodb";

export type CapitalLedgerEntryType = "RESERVE" | "RELEASE" | "ADJUST";

// The capital ledger from CLAUDE.md's Risk Manager section — each strategy
// reserves funds here before placing an order, so two strategies can't both
// spend the same balance. balanceAfter makes each entry self-auditing.
export interface CapitalLedgerEntry {
  _id: ObjectId;
  strategyId: ObjectId;
  type: CapitalLedgerEntryType;
  amount: Decimal128;
  asset: string;
  relatedOrderId?: ObjectId;
  balanceAfter: Decimal128;
  reason: string;
  createdAt: Date;
}
