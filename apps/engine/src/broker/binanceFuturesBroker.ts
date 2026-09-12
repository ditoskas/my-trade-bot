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
// never knows the difference. MARKET orders only. Margin mode and leverage
// are configured once per symbol via configureSymbol before trading it, not
// passed per order — Binance doesn't support varying them per-order anyway.
//
// Position mode (One-way vs Hedge/dual-side) is READ, never WRITTEN, by
// this class — see detectPositionMode's comment for why. placeOrder adapts
// to whichever mode the account is actually in.
//
// Unlike spot, a futures order's own REST response doesn't include
// commission per fill — placeOrder makes one extra signed call
// (getAccountTradeList) to fetch the real fills/commission for the order
// it just placed, rather than guessing at a fee rate.
export class BinanceFuturesBroker implements Broker {
  private readonly client: UMFutures;
  private readonly stepSizeCache = new Map<string, Decimal>();
  private hedgeMode: boolean | null = null;

  constructor(options: BinanceFuturesBrokerOptions) {
    this.client = new UMFutures(options.apiKey, options.apiSecret, {
      baseURL: options.useTestnet ? FUTURES_TESTNET_URL : FUTURES_PROD_URL,
    });
  }

  // Read-only — this used to actively FORCE the account into One-way mode
  // on every strategy startup (changePositionMode("false")). Removed
  // 2026-09-12 after that call took the engine down for ~34 hours
  // undetected: Binance's changePositionMode returns -4067 ("Position side
  // cannot be changed if there exists open orders") whenever the account
  // genuinely isn't already in the target mode AND has open orders/
  // positions on it — exactly the operator's normal situation (their own
  // manual Hedge-Mode trading on this account/symbol). That -4067 was
  // uncaught, threw out of startBtcHighRiskRuntime inside index.ts's
  // catalog loop, and left the strategy silently never started (see the
  // incident writeup in CLAUDE.md Phase 3b — the process itself didn't
  // die, since the demo strategies ahead of it in the catalog kept the
  // event loop alive, so systemd never noticed either).
  //
  // The operator wants their own manual positions on this account left
  // completely alone regardless of what mode the account is in, so this
  // broker no longer tries to CHANGE the account's position mode at all —
  // it only detects and adapts to whatever mode is already active (see
  // placeOrder/getOpenPosition). Cached after the first successful read;
  // call again to force a re-check (e.g. if the operator changes the mode
  // by hand mid-run).
  async detectPositionMode(): Promise<boolean> {
    try {
      const current = await this.client.getPositionMode();
      const dualSidePosition = asRecord(current.data)["dualSidePosition"];
      this.hedgeMode = dualSidePosition === true || dualSidePosition === "true";
    } catch (error) {
      console.warn(
        "[broker:binance-futures] couldn't read current position mode, assuming One-way:",
        (error as Error).message,
      );
      this.hedgeMode = false;
    }
    return this.hedgeMode;
  }

  private async isHedgeMode(): Promise<boolean> {
    if (this.hedgeMode === null) {
      await this.detectPositionMode();
    }
    return this.hedgeMode as boolean;
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
  // interface comment on why this exists. In Hedge Mode, Binance reports a
  // separate entry per positionSide (LONG/SHORT) for the same symbol — e.g.
  // this strategy's own position alongside the operator's unrelated manual
  // one — so `side`, when given, picks out the entry the caller actually
  // means; omitted, the first non-flat entry wins (matches the old One-way-
  // only behavior, where there's only ever one). positionAmt is signed
  // (positive = long, negative = short, "0" = flat) regardless of mode.
  async getOpenPosition(symbol: string, side?: "LONG" | "SHORT"): Promise<OpenPositionInfo | null> {
    const response = await this.client.getPositionInformationV3({ symbol });
    const positions = Array.isArray(response.data) ? response.data.map(asRecord) : [];
    const position = positions.find((entry) => {
      if (entry["symbol"] !== symbol) {
        return false;
      }
      const positionAmt = new Decimal(readString(entry, "positionAmt") ?? "0");
      if (positionAmt.isZero()) {
        return false;
      }
      if (!side) {
        return true;
      }
      // "BOTH" is what Binance reports in One-way mode, where there's no
      // separate LONG/SHORT entry to disambiguate anyway.
      const positionSideRaw = readString(entry, "positionSide");
      return positionSideRaw === side || positionSideRaw === "BOTH";
    });
    if (!position) {
      return null;
    }

    const positionAmt = new Decimal(readString(position, "positionAmt") ?? "0");
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

    // Hedge Mode requires positionSide on every order and rejects reduceOnly
    // outright (-1106) — closing is implicit there: an order on the same
    // positionSide but the opposite side reduces it, no flag needed. One-way
    // mode is the reverse: positionSide must be omitted (Binance defaults it
    // to "BOTH" and rejects an explicit LONG/SHORT with -4061), reduceOnly is
    // how a close is expressed. See detectPositionMode's comment for why
    // this reads the mode instead of forcing one.
    const isHedge = await this.isHedgeMode();
    const response = await this.client.newOrder(request.symbol, request.side, "MARKET", {
      // Passed as a string, not Number() — unlike @binance/spot, this
      // connector doesn't force a numeric type, so there's no float
      // round-trip on the way out at all.
      quantity: quantity.toString(),
      newClientOrderId: request.clientOrderId,
      reduceOnly: !isHedge && request.reduceOnly ? "true" : undefined,
      positionSide: isHedge ? request.positionSide : undefined,
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
