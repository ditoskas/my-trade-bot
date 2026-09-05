import type { OrderStatus } from "@trade-bot/shared";

// Binance's spot and futures REST APIs use the same order-status strings —
// shared by both BinanceBroker and BinanceFuturesBroker rather than
// duplicated.
export function mapOrderStatus(status: string | undefined): OrderStatus {
  switch (status) {
    case "NEW":
      return "SUBMITTED";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "FILLED":
      return "FILLED";
    case "CANCELED":
    case "PENDING_CANCEL":
    case "EXPIRED":
    case "EXPIRED_IN_MATCH":
      return "CANCELED";
    case "REJECTED":
      return "REJECTED";
    default:
      // Binance sometimes adds new statuses — fail loud-but-recorded rather
      // than crash the engine on one we don't recognize yet.
      return "FAILED";
  }
}
