import { UMFutures } from "@binance/futures-connector";
import { Decimal } from "decimal.js";
import { fromDecimalJs, toDecimal128, toDecimalJs, type MarginMode } from "@trade-bot/shared";
import { mapOrderStatus } from "./orderStatus";
import type { Broker, OpenPositionInfo, OrderResult, PlaceOrderRequest } from "./types";

export interface BinanceFuturesBrokerOptions {
  apiKey: string;
  apiSecret: string;
  useTestnet?: boolean;
}

const FUTURES_PROD_URL = "https://fapi.binance.com";
const FUTURES_TESTNET_URL = "https://testnet.binancefuture.com";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

// Binance returns these codes when the account/symbol is already in the
// requested mode — treated as success, not failure, since configureSymbol/
// configureOneWayPositionMode are meant to be safely callable every time a
// strategy starts, not just once ever.
function isAlreadyInModeError(error: unknown): boolean {
  const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
  return code === -4059 || code === -4046;
}

function roundToStepSize(quantity: Decimal, stepSize: Decimal): Decimal {
  if (stepSize.isZero()) {
    return quantity;
  }
  return quantity.div(stepSize).floor().mul(stepSize);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Talks to Binance's USDT-M perpetual futures API via the official (but
// early — v0.1.7, ships no TypeScript types) @binance/futures-connector.
// See CLAUDE.md Phase 3b for why it's treated as less battle-tested than
// @binance/spot, and futuresConnectorTypes.d.ts for the ambient types this
// file relies on.
//
// Same Broker interface as PaperBroker/BinanceBroker — StrategyRunner
// never knows the difference. MARKET orders only, one-way position mode
// only (configureOneWayPositionMode). Margin mode and leverage are
// configured once per symbol via configureSymbol before trading it, not
// passed per order — Binance doesn't support varying them per-order anyway.
//
// Unlike spot, a futures order's own REST response doesn't include
// commission per fill — placeOrder makes one extra signed call
// (getAccountTradeList) to fetch the real fills/commission for the order
// it just placed, rather than guessing at a fee rate.
export class BinanceFuturesBroker implements Broker {
  private readonly client: UMFutures;
  private readonly stepSizeCache = new Map<string, Decimal>();

  constructor(options: BinanceFuturesBrokerOptions) {
    this.client = new UMFutures(options.apiKey, options.apiSecret, {
      baseURL: options.useTestnet ? FUTURES_TESTNET_URL : FUTURES_PROD_URL,
    });
  }

  async configureOneWayPositionMode(): Promise<void> {
    try {
      await this.client.changePositionMode("false");
    } catch (error) {
      if (!isAlreadyInModeError(error)) {
        throw error;
      }
    }
  }

  async configureSymbol(symbol: string, leverage: number, marginMode: MarginMode): Promise<void> {
    try {
      await this.client.changeMarginType(symbol, marginMode);
    } catch (error) {
      if (!isAlreadyInModeError(error)) {
        throw error;
      }
    }
    await this.client.changeInitialLeverage(symbol, leverage);
  }

  // Real exchange truth, not Mongo/in-memory state — see the Broker
  // interface comment on why this exists. One-way position mode only
  // (matches configureOneWayPositionMode), so there's at most one position
  // per symbol to find; positionAmt is signed (positive = long, negative =
  // short, "0" = flat).
  async getOpenPosition(symbol: string): Promise<OpenPositionInfo | null> {
    const response = await this.client.getPositionInformationV3({ symbol });
    const positions = Array.isArray(response.data) ? response.data.map(asRecord) : [];
    const position = positions.find((entry) => entry["symbol"] === symbol);
    if (!position) {
      return null;
    }

    const positionAmt = new Decimal(readString(position, "positionAmt") ?? "0");
    if (positionAmt.isZero()) {
      return null;
    }

    return {
      side: positionAmt.isPositive() ? "LONG" : "SHORT",
      quantity: toDecimal128(positionAmt.abs().toString()),
      entryPrice: toDecimal128(readString(position, "entryPrice") ?? "0"),
    };
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderResult> {
    if (request.type !== "MARKET") {
      throw new Error(`BinanceFuturesBroker only supports MARKET orders so far, got ${request.type}`);
    }

    const stepSize = await this.getStepSize(request.symbol);
    const quantity = roundToStepSize(toDecimalJs(request.quantity), stepSize);

    const response = await this.client.newOrder(request.symbol, request.side, "MARKET", {
      // Passed as a string, not Number() — unlike @binance/spot, this
      // connector doesn't force a numeric type, so there's no float
      // round-trip on the way out at all.
      quantity: quantity.toString(),
      newClientOrderId: request.clientOrderId,
      reduceOnly: request.reduceOnly ? "true" : undefined,
    });

    const data = asRecord(response.data);
    const orderId = data["orderId"];
    const fills =
      typeof orderId === "number" || typeof orderId === "string"
        ? await this.getFillsForOrder(request.symbol, orderId)
        : [];

    // Unlike spot, a futures MARKET order's own newOrder response doesn't
    // reliably reflect the fill yet — observed live on testnet returning
    // status "NEW"/executedQty "0" *while the fills we just fetched above
    // already show it filled*. Derive the authoritative state from those
    // fills instead of trusting the order response's own snapshot.
    // Known gap: if getAccountTradeList raced ahead of the fill actually
    // landing there, fills comes back empty and this falls back to the
    // (possibly stale) order response — a real edge case, not solved here,
    // that a retry/poll loop would close before this is trusted with real
    // money (see CLAUDE.md Phase 3b / Phase 6).
    if (fills.length > 0) {
      const executedQuantity = fills.reduce((sum, fill) => sum.plus(toDecimalJs(fill.quantity)), new Decimal(0));
      const cumulativeQuoteQuantity = fills.reduce(
        (sum, fill) => sum.plus(toDecimalJs(fill.quantity).mul(toDecimalJs(fill.price))),
        new Decimal(0),
      );
      const isFullyFilled = executedQuantity.greaterThanOrEqualTo(quantity);

      return {
        exchangeOrderId: orderId !== undefined ? String(orderId) : "",
        status: isFullyFilled ? "FILLED" : "PARTIALLY_FILLED",
        executedQuantity: fromDecimalJs(executedQuantity),
        cumulativeQuoteQuantity: fromDecimalJs(cumulativeQuoteQuantity),
        fills,
      };
    }

    return {
      exchangeOrderId: orderId !== undefined ? String(orderId) : "",
      status: mapOrderStatus(readString(data, "status")),
      executedQuantity: toDecimal128(readString(data, "executedQty") ?? "0"),
      cumulativeQuoteQuantity: toDecimal128(readString(data, "cumQuote") ?? "0"),
      fills,
    };
  }

  // Phase 6: closes the race flagged when this was first built — the fill
  // can land in the trade list a beat after the order response comes back.
  // Retries a few times before giving up and letting the caller fall back
  // to the (possibly stale) order response.
  private async getFillsForOrder(symbol: string, orderId: number | string): Promise<OrderResult["fills"]> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.client.getAccountTradeList(symbol, { orderId });
      const trades = Array.isArray(response.data) ? response.data : [];

      if (trades.length > 0) {
        return trades.map((trade) => {
          const record = asRecord(trade);
          const id = record["id"];
          return {
            price: toDecimal128(readString(record, "price") ?? "0"),
            quantity: toDecimal128(readString(record, "qty") ?? "0"),
            commission: toDecimal128(readString(record, "commission") ?? "0"),
            commissionAsset: readString(record, "commissionAsset") ?? "",
            tradeId: id !== undefined ? String(id) : undefined,
            timestamp: new Date(),
          };
        });
      }

      if (attempt < maxAttempts) {
        await sleep(300);
      }
    }
    return [];
  }

  private async getStepSize(symbol: string): Promise<Decimal> {
    const cached = this.stepSizeCache.get(symbol);
    if (cached) {
      return cached;
    }

    const response = await this.client.getExchangeInfo();
    const data = asRecord(response.data);
    const symbols = Array.isArray(data["symbols"]) ? data["symbols"] : [];
    const symbolInfo = symbols.map(asRecord).find((entry) => entry["symbol"] === symbol);
    const filters = Array.isArray(symbolInfo?.["filters"]) ? symbolInfo["filters"] : [];
    const lotSizeFilter = filters.map(asRecord).find((filter) => filter["filterType"] === "LOT_SIZE");
    const stepSize = new Decimal(readString(lotSizeFilter ?? {}, "stepSize") ?? "0.001");

    this.stepSizeCache.set(symbol, stepSize);
    return stepSize;
  }
}
