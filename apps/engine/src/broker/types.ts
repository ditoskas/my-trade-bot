import type { Decimal128 } from "mongodb";
import type { OrderFill, OrderSide, OrderStatus, OrderType } from "@trade-bot/shared";

export interface Candle {
  symbol: string;
  openTime: Date;
  closeTime: Date;
  open: Decimal128;
  high: Decimal128;
  low: Decimal128;
  close: Decimal128;
  volume: Decimal128;
}

export interface PlaceOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: Decimal128;
  price?: Decimal128;
  // Futures-only — PaperBroker and BinanceBroker (spot) ignore it. Only
  // actually sent to Binance when the account is in Hedge (dual-side)
  // Position Mode — see BinanceFuturesBroker.placeOrder.
  reduceOnly?: boolean;
  // Futures-only — the position this order belongs to (not the order's
  // buy/sell direction). Required by Binance whenever the account is in
  // Hedge Mode; ignored (and not sent) in One-way mode, where a position
  // is implicitly "BOTH". PaperBroker and BinanceBroker (spot) ignore it.
  positionSide?: "LONG" | "SHORT";
}

export interface OrderResult {
  exchangeOrderId: string;
  status: OrderStatus;
  executedQuantity: Decimal128;
  cumulativeQuoteQuantity: Decimal128;
  fills: OrderFill[];
}

export interface OpenPositionInfo {
  side: "LONG" | "SHORT";
  quantity: Decimal128;
  entryPrice: Decimal128;
}

// PaperBroker (Phase 2) and BinanceBroker (Phase 3) both implement this —
// strategy and runner code never know which one they're talking to, so the
// same strategy runs unmodified in paper and live (see CLAUDE.md).
export interface Broker {
  placeOrder(request: PlaceOrderRequest): Promise<OrderResult>;
  // Optional: lets StrategyRunner reconcile its in-memory position state
  // against the real exchange on startup, instead of always assuming
  // flat. Without this, a restart while a real position is open (the
  // engine's position tracking is in-memory only) could make the runner
  // think it's flat and open a second position on top of the real one
  // still sitting on the exchange — exactly the "only one position open
  // at a time" guarantee breaking down. PaperBroker doesn't implement
  // this (its positions are ephemeral by construction — nothing to
  // recover); BinanceFuturesBroker does, via a real position-risk query.
  // `side`: in Hedge Mode the exchange can report a LONG and a SHORT
  // position on the same symbol simultaneously (e.g. this strategy's own
  // position alongside the operator's unrelated manual one) — pass the
  // side the caller actually wants to check to disambiguate; omitted, the
  // first non-flat position found is returned.
  getOpenPosition?(symbol: string, side?: "LONG" | "SHORT"): Promise<OpenPositionInfo | null>;
}
