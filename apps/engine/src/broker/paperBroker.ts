import { randomUUID } from "node:crypto";
import type { Decimal128 } from "mongodb";
import { Decimal } from "decimal.js";
import { fromDecimalJs, toDecimalJs } from "@trade-bot/shared";
import type { Broker, OrderResult, PlaceOrderRequest } from "./types.js";

export interface PaperBrokerOptions {
  // Default matches Binance's standard 0.1% taker fee.
  feeRate?: string;
  feeAsset?: string;
}

// Fills every order completely and instantly at the last price fed in via
// setPrice() — no partial fills, slippage, or latency simulation. That's
// enough to prove the engine pipeline end to end (Phase 2's goal), but it
// means paper results will look better than live ones; don't trust this to
// predict live behavior before Phase 3's backtest-vs-live gap gets closed.
export class PaperBroker implements Broker {
  private readonly prices = new Map<string, Decimal>();
  private readonly feeRate: Decimal;
  private readonly feeAsset: string;

  constructor(options: PaperBrokerOptions = {}) {
    this.feeRate = new Decimal(options.feeRate ?? "0.001");
    this.feeAsset = options.feeAsset ?? "USDT";
  }

  setPrice(symbol: string, price: Decimal128): void {
    this.prices.set(symbol, toDecimalJs(price));
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderResult> {
    const price = this.prices.get(request.symbol);
    if (!price) {
      throw new Error(`PaperBroker has no price for ${request.symbol} yet — call setPrice() first`);
    }

    const quantity = toDecimalJs(request.quantity);
    const quoteQuantity = quantity.mul(price);
    const commission = quoteQuantity.mul(this.feeRate);

    return {
      exchangeOrderId: `paper-${randomUUID()}`,
      status: "FILLED",
      executedQuantity: request.quantity,
      cumulativeQuoteQuantity: fromDecimalJs(quoteQuantity),
      fills: [
        {
          price: fromDecimalJs(price),
          quantity: request.quantity,
          commission: fromDecimalJs(commission),
          commissionAsset: this.feeAsset,
          timestamp: new Date(),
        },
      ],
    };
  }
}
