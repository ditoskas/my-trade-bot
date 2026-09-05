import type { Decimal128, ObjectId } from "mongodb";

export type TradeSide = "LONG" | "SHORT";

export type TradeCloseReason =
  | "signal"
  | "stop_loss"
  | "take_profit"
  | "manual"
  | "kill_switch";

// A closed round-trip, derived from one or more entry/exit orders' fills —
// this is what the dashboard's stats (Sharpe, win rate, etc.) are computed
// from, not the raw orders collection.
export interface Trade {
  _id: ObjectId;
  strategyId: ObjectId;
  symbol: string;
  side: TradeSide;
  entryOrderIds: ObjectId[];
  exitOrderIds: ObjectId[];
  entryPrice: Decimal128;
  exitPrice: Decimal128;
  quantity: Decimal128;
  pnl: Decimal128;
  pnlPct: number;
  feesPaid: Decimal128;
  feeAsset: string;
  entryTime: Date;
  exitTime: Date;
  durationMs: number;
  closeReason: TradeCloseReason;
}
