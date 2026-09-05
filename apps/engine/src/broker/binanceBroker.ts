import { Spot, SpotRestAPI, SPOT_REST_API_PROD_URL, SPOT_REST_API_TESTNET_URL } from "@binance/spot";
import { Decimal } from "decimal.js";
import { toDecimal128, toDecimalJs } from "@trade-bot/shared";
import { mapOrderStatus } from "./orderStatus";
import type { Broker, OrderResult, PlaceOrderRequest } from "./types";

export interface BinanceBrokerOptions {
  apiKey: string;
  apiSecret: string;
  useTestnet?: boolean;
}

// Talks to Binance directly via the official connector — never through MCP
// or an LLM tool call, per CLAUDE.md's non-negotiable policy. Implements
// the same Broker interface as PaperBroker, so StrategyRunner and every
// StrategyAlgorithm are unmodified between paper and live.
//
// MARKET orders only, matching what StrategyRunner issues today. A market
// order's synchronous REST response already contains its fills, so this
// doesn't need the user-data WebSocket yet — that becomes necessary once
// LIMIT orders (which can fill asynchronously, later) are introduced.
export class BinanceBroker implements Broker {
  private readonly client: Spot;
  private readonly stepSizeCache = new Map<string, Decimal>();

  constructor(options: BinanceBrokerOptions) {
    this.client = new Spot({
      configurationRestAPI: {
        apiKey: options.apiKey,
        apiSecret: options.apiSecret,
        basePath: options.useTestnet ? SPOT_REST_API_TESTNET_URL : SPOT_REST_API_PROD_URL,
      },
    });
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderResult> {
    if (request.type !== "MARKET") {
      throw new Error(`BinanceBroker only supports MARKET orders so far, got ${request.type}`);
    }

    const stepSize = await this.getStepSize(request.symbol);
    const quantity = roundToStepSize(toDecimalJs(request.quantity), stepSize);

    const response = await this.client.restAPI.newOrder({
      symbol: request.symbol,
      side: request.side === "BUY" ? SpotRestAPI.NewOrderSideEnum.BUY : SpotRestAPI.NewOrderSideEnum.SELL,
      type: SpotRestAPI.NewOrderTypeEnum.MARKET,
      // The connector's request type takes quantity as a plain number —
      // that's the SDK's own choice, not ours; Number() here is safe for
      // realistic order sizes since quantity was just rounded to the
      // exchange's own step size (typically <=8 decimal places).
      quantity: Number(quantity.toString()),
      newClientOrderId: request.clientOrderId,
    });

    const data = await response.data();

    return {
      exchangeOrderId: data.orderId !== undefined ? String(data.orderId) : "",
      status: mapOrderStatus(data.status),
      executedQuantity: toDecimal128(data.executedQty ?? "0"),
      cumulativeQuoteQuantity: toDecimal128(data.cummulativeQuoteQty ?? "0"),
      fills: (data.fills ?? []).map((fill) => ({
        price: toDecimal128(fill.price ?? "0"),
        quantity: toDecimal128(fill.qty ?? "0"),
        commission: toDecimal128(fill.commission ?? "0"),
        commissionAsset: fill.commissionAsset ?? "",
        tradeId: fill.tradeId !== undefined ? String(fill.tradeId) : undefined,
        timestamp: new Date(),
      })),
    };
  }

  private async getStepSize(symbol: string): Promise<Decimal> {
    const cached = this.stepSizeCache.get(symbol);
    if (cached) {
      return cached;
    }

    const response = await this.client.restAPI.exchangeInfo({ symbol });
    const data = await response.data();
    const symbolInfo = data.symbols?.[0] as { filters?: Array<Record<string, unknown>> } | undefined;
    const lotSizeFilter = symbolInfo?.filters?.find((filter) => filter["filterType"] === "LOT_SIZE");
    const stepSizeValue = lotSizeFilter?.["stepSize"];
    const stepSize = new Decimal(typeof stepSizeValue === "string" ? stepSizeValue : "0.00000001");

    this.stepSizeCache.set(symbol, stepSize);
    return stepSize;
  }
}

function roundToStepSize(quantity: Decimal, stepSize: Decimal): Decimal {
  if (stepSize.isZero()) {
    return quantity;
  }
  return quantity.div(stepSize).floor().mul(stepSize);
}
