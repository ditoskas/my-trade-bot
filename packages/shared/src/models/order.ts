import type { Decimal128, ObjectId } from "mongodb";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";

// PENDING_INTENT is written before the exchange is ever called — the outbox
// pattern from CLAUDE.md Phase 3, so a crash mid-placement is recoverable
// via reconciliation instead of ambiguous.
export type OrderStatus =
  | "PENDING_INTENT"
  | "SUBMITTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "FAILED";

export interface OrderFill {
  price: Decimal128;
  quantity: Decimal128;
  commission: Decimal128;
  commissionAsset: string;
  tradeId?: string;
  timestamp: Date;
}

export interface Order {
  _id: ObjectId;
  strategyId: ObjectId;
  // Idempotency key sent to Binance as newClientOrderId — lets a restart
  // reconcile without risking a duplicate order.
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: Decimal128;
  price?: Decimal128;
  status: OrderStatus;
  exchangeOrderId?: string;
  executedQuantity: Decimal128;
  cumulativeQuoteQuantity: Decimal128;
  fills: OrderFill[];
  // Futures-only: ensures a closing order can only reduce/close an existing
  // position, never open one in the wrong direction. Meaningless for spot.
  reduceOnly?: boolean;
  errorMessage?: string;
  intentCreatedAt: Date;
  submittedAt?: Date;
  updatedAt: Date;
}
