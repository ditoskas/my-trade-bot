import type { Decimal128, ObjectId } from "mongodb";

export interface EquitySnapshot {
  _id: ObjectId;
  // null = whole-account snapshot rather than one strategy's slice.
  strategyId: ObjectId | null;
  timestamp: Date;
  equity: Decimal128;
  allocatedCapital: Decimal128;
  unrealizedPnl: Decimal128;
  realizedPnlCumulative: Decimal128;
  openPositionsCount: number;
}
