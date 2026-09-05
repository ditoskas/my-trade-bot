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
  // 1 for spot. For futures this is what turned margin into notional
  // exposure — see CLAUDE.md Phase 3b.
  leverage: number;
  pnl: Decimal128;
  pnlPct: number;
  feesPaid: Decimal128;
  feeAsset: string;
  // Futures perpetuals accrue funding periodically while a position is
  // open — a real PnL component spot never had. Field exists so the shape
  // is ready, but nothing computes it from Binance's income history yet;
  // always 0 until that's built. Don't read this as "this trade had no
  // funding cost," read it as "funding cost isn't tracked yet."
  fundingFeesPaid: Decimal128;
  entryTime: Date;
  exitTime: Date;
  durationMs: number;
  closeReason: TradeCloseReason;
}
