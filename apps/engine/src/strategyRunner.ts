import { ObjectId, type Db } from "mongodb";
import { Decimal } from "decimal.js";
import {
  auditLogCollection,
  fromDecimalJs,
  ordersCollection,
  toDecimalJs,
  tradesCollection,
  type AuditEventType,
  type Strategy,
} from "@trade-bot/shared";
import type { Broker, Candle } from "./broker/types.js";
import { CapitalLedger } from "./risk/capitalLedger.js";
import { RiskManager } from "./risk/riskManager.js";
import type { StrategyAlgorithm, StrategyPositionState } from "./strategy/types.js";

interface OpenPosition {
  quantity: Decimal;
  entryPrice: Decimal;
  entryOrderId: ObjectId;
  entryTime: Date;
}

// Orchestrates one strategy: candle in -> algorithm.decide() -> risk check
// -> capital reservation -> broker order -> orders/trades/audit_log in
// Mongo. See CLAUDE.md's Engine section for the full flow this implements.
//
// Known limitation: position state lives in memory only, reset on restart.
// Rebuilding it from Mongo (and reconciling against the exchange) is a
// Phase 3 concern, not solved here — acceptable for paper trading, not for
// real money.
export class StrategyRunner {
  private openPosition: OpenPosition | null = null;

  constructor(
    private readonly db: Db,
    private readonly strategyDoc: Strategy,
    private readonly algorithm: StrategyAlgorithm,
    private readonly broker: Broker,
    private readonly riskManager: RiskManager,
    private readonly capitalLedger: CapitalLedger,
  ) {}

  async onCandle(candle: Candle): Promise<void> {
    const positionState: StrategyPositionState = {
      isOpen: this.openPosition !== null,
      quantity: fromDecimalJs(this.openPosition?.quantity ?? new Decimal(0)),
    };

    const signal = this.algorithm.decide(candle, positionState);
    if (signal === "HOLD") {
      return;
    }

    await this.audit("DECISION", { symbol: candle.symbol, signal, close: candle.close.toString() });

    if (signal === "ENTER_LONG" && !positionState.isOpen) {
      await this.enterLong(candle);
    } else if (signal === "EXIT_LONG" && positionState.isOpen) {
      await this.exitLong(candle);
    }
  }

  private async enterLong(candle: Candle): Promise<void> {
    this.riskManager.checkCanEnter(this.strategyDoc);

    const freeCapital = await this.capitalLedger.getFreeCapital(this.strategyDoc);
    if (freeCapital.lessThanOrEqualTo(0)) {
      await this.audit("RISK_BLOCK", { reason: "no free capital", strategy: this.strategyDoc.slug });
      return;
    }

    const price = toDecimalJs(candle.close);
    const quantity = freeCapital.div(price);
    const orderId = new ObjectId();
    const clientOrderId = `paper-${orderId.toHexString()}`;

    await ordersCollection(this.db).insertOne({
      _id: orderId,
      strategyId: this.strategyDoc._id,
      clientOrderId,
      symbol: candle.symbol,
      side: "BUY",
      type: "MARKET",
      quantity: fromDecimalJs(quantity),
      status: "PENDING_INTENT",
      executedQuantity: fromDecimalJs(new Decimal(0)),
      cumulativeQuoteQuantity: fromDecimalJs(new Decimal(0)),
      fills: [],
      intentCreatedAt: new Date(),
      updatedAt: new Date(),
    });
    await this.audit("ORDER_INTENT", {
      orderId: orderId.toHexString(),
      side: "BUY",
      quantity: quantity.toString(),
    });

    // Reserved *after* the intent is written but *before* the broker call —
    // the outbox record exists either way if this crashes mid-call.
    await this.capitalLedger.reserve(this.strategyDoc, freeCapital, "enter_long", orderId);

    const result = await this.broker.placeOrder({
      clientOrderId,
      symbol: candle.symbol,
      side: "BUY",
      type: "MARKET",
      quantity: fromDecimalJs(quantity),
    });

    await ordersCollection(this.db).updateOne(
      { _id: orderId },
      {
        $set: {
          status: result.status,
          exchangeOrderId: result.exchangeOrderId,
          executedQuantity: result.executedQuantity,
          cumulativeQuoteQuantity: result.cumulativeQuoteQuantity,
          fills: result.fills,
          submittedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );

    this.openPosition = {
      quantity: toDecimalJs(result.executedQuantity),
      entryPrice: price,
      entryOrderId: orderId,
      entryTime: candle.closeTime,
    };

    await this.audit("ORDER_FILLED", {
      orderId: orderId.toHexString(),
      side: "BUY",
      price: price.toString(),
      quantity: result.executedQuantity.toString(),
    });
  }

  private async exitLong(candle: Candle): Promise<void> {
    const position = this.openPosition;
    if (!position) {
      return;
    }

    const orderId = new ObjectId();
    const clientOrderId = `paper-${orderId.toHexString()}`;

    await ordersCollection(this.db).insertOne({
      _id: orderId,
      strategyId: this.strategyDoc._id,
      clientOrderId,
      symbol: candle.symbol,
      side: "SELL",
      type: "MARKET",
      quantity: fromDecimalJs(position.quantity),
      status: "PENDING_INTENT",
      executedQuantity: fromDecimalJs(new Decimal(0)),
      cumulativeQuoteQuantity: fromDecimalJs(new Decimal(0)),
      fills: [],
      intentCreatedAt: new Date(),
      updatedAt: new Date(),
    });
    await this.audit("ORDER_INTENT", {
      orderId: orderId.toHexString(),
      side: "SELL",
      quantity: position.quantity.toString(),
    });

    const result = await this.broker.placeOrder({
      clientOrderId,
      symbol: candle.symbol,
      side: "SELL",
      type: "MARKET",
      quantity: fromDecimalJs(position.quantity),
    });

    await ordersCollection(this.db).updateOne(
      { _id: orderId },
      {
        $set: {
          status: result.status,
          exchangeOrderId: result.exchangeOrderId,
          executedQuantity: result.executedQuantity,
          cumulativeQuoteQuantity: result.cumulativeQuoteQuantity,
          fills: result.fills,
          submittedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );

    const fillPrice = toDecimalJs(result.fills[0]!.price);
    const fees = result.fills.reduce((sum, fill) => sum.plus(toDecimalJs(fill.commission)), new Decimal(0));
    const proceeds = toDecimalJs(result.cumulativeQuoteQuantity).minus(fees);
    const costBasis = position.entryPrice.mul(position.quantity);
    const pnl = proceeds.minus(costBasis);
    const pnlPct = costBasis.isZero() ? new Decimal(0) : pnl.div(costBasis).mul(100);

    await tradesCollection(this.db).insertOne({
      _id: new ObjectId(),
      strategyId: this.strategyDoc._id,
      symbol: candle.symbol,
      side: "LONG",
      entryOrderIds: [position.entryOrderId],
      exitOrderIds: [orderId],
      entryPrice: fromDecimalJs(position.entryPrice),
      exitPrice: fromDecimalJs(fillPrice),
      quantity: fromDecimalJs(position.quantity),
      pnl: fromDecimalJs(pnl),
      pnlPct: pnlPct.toNumber(),
      feesPaid: fromDecimalJs(fees),
      feeAsset: result.fills[0]!.commissionAsset,
      entryTime: position.entryTime,
      exitTime: candle.closeTime,
      durationMs: candle.closeTime.getTime() - position.entryTime.getTime(),
      closeReason: "signal",
    });

    await this.capitalLedger.release(this.strategyDoc, proceeds, "exit_long", orderId);
    this.openPosition = null;

    await this.audit("ORDER_FILLED", {
      orderId: orderId.toHexString(),
      side: "SELL",
      pnl: pnl.toString(),
    });
  }

  private async audit(eventType: AuditEventType, payload: Record<string, unknown>): Promise<void> {
    await auditLogCollection(this.db).insertOne({
      _id: new ObjectId(),
      strategyId: this.strategyDoc._id,
      eventType,
      source: "engine",
      payload,
      timestamp: new Date(),
    });
  }
}
