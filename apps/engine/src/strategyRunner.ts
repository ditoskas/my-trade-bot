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
import type { Broker, Candle } from "./broker/types";
import type { EventPublisher } from "./events/redisPublisher";
import { CapitalLedger } from "./risk/capitalLedger";
import { checkDrawdownBreaker } from "./risk/drawdownBreaker";
import { RiskManager } from "./risk/riskManager";
import type { StrategyAlgorithm, StrategyPositionState } from "./strategy/types";

type PositionSide = "LONG" | "SHORT";

interface OpenPosition {
  side: PositionSide;
  quantity: Decimal;
  entryPrice: Decimal;
  // The strategy's free capital at entry, used as margin (futures) or the
  // full cost basis (spot, leverage 1) — see exitPosition for why this one
  // number covers both cases.
  marginReserved: Decimal;
  entryFee: Decimal;
  entryOrderId: ObjectId;
  entryTime: Date;
}

// Orchestrates one strategy: candle in -> algorithm.decide() -> risk check
// -> capital reservation -> broker order -> orders/trades/audit_log in
// Mongo. See CLAUDE.md's Engine section for the full flow this implements,
// and Phase 3b for the long/short + leverage generalization.
//
// Known limitation: position state is in-memory only, reset on restart.
// Rebuilding it from Mongo (and reconciling against the exchange) is a
// Phase 3 concern, not solved here — acceptable for paper trading, not for
// real money.
export class StrategyRunner {
  private openPosition: OpenPosition | null = null;
  // Guards enterPosition/exitPosition, not decide() — the algorithm's
  // indicator state (e.g. its moving-average window) must still update on
  // every candle, but two overlapping order actions for the same strategy
  // must not both start. Without this: if a candle arrives while a prior
  // enterPosition is still mid-await (broker/DB calls), positionState is
  // computed from `this.openPosition`, which isn't set until that prior
  // call finishes — so the new candle could see "flat" and try to enter
  // again concurrently. Found while doing the Phase 6 hardening pass, not
  // hit live yet (1-minute candles rarely close before a broker call
  // returns), but real and worth closing before real capital.
  private busy = false;

  constructor(
    private readonly db: Db,
    private readonly strategyDoc: Strategy,
    private readonly algorithm: StrategyAlgorithm,
    private readonly broker: Broker,
    private readonly riskManager: RiskManager,
    private readonly capitalLedger: CapitalLedger,
    // Optional — a strategy still runs correctly with no live dashboard
    // feed at all (see EventPublisher.connect's fail-open behavior).
    private readonly publisher?: EventPublisher,
  ) {}

  async onCandle(candle: Candle): Promise<void> {
    const positionState: StrategyPositionState = {
      isOpen: this.openPosition !== null,
      side: this.openPosition?.side ?? null,
      quantity: fromDecimalJs(this.openPosition?.quantity ?? new Decimal(0)),
    };

    const signal = this.algorithm.decide(candle, positionState);
    if (signal === "HOLD") {
      return;
    }

    if (this.busy) {
      console.warn(
        `[strategy:${this.strategyDoc.slug}] still processing a previous signal — skipping ${signal} for this candle rather than risk overlapping orders`,
      );
      return;
    }

    this.busy = true;
    try {
      await this.audit("DECISION", { symbol: candle.symbol, signal, close: candle.close.toString() });

      // ENTER_LONG/ENTER_SHORT mean "be long/short after this" — if the
      // opposite side is currently open, that's a flip (exit, then re-enter
      // the other way), not just "open from flat." See
      // MovingAverageCrossStrategy's comment for why this matters: without
      // it, one direction becomes structurally unreachable.
      if (signal === "ENTER_LONG") {
        if (positionState.isOpen && positionState.side === "SHORT") {
          await this.exitPosition(candle);
        }
        if (!this.openPosition) {
          await this.enterPosition("LONG", candle);
        }
      } else if (signal === "ENTER_SHORT") {
        if (positionState.isOpen && positionState.side === "LONG") {
          await this.exitPosition(candle);
        }
        if (!this.openPosition) {
          await this.enterPosition("SHORT", candle);
        }
      } else if (signal === "EXIT_LONG" && positionState.isOpen && positionState.side === "LONG") {
        await this.exitPosition(candle);
      } else if (signal === "EXIT_SHORT" && positionState.isOpen && positionState.side === "SHORT") {
        await this.exitPosition(candle);
      }
    } finally {
      this.busy = false;
    }
  }

  private async enterPosition(side: PositionSide, candle: Candle): Promise<void> {
    this.riskManager.checkCanEnter(this.strategyDoc);

    const freeCapital = await this.capitalLedger.getFreeCapital(this.strategyDoc);
    if (freeCapital.lessThanOrEqualTo(0)) {
      await this.audit("RISK_BLOCK", { reason: "no free capital", strategy: this.strategyDoc.slug });
      return;
    }

    const price = toDecimalJs(candle.close);
    // Leverage turns margin (freeCapital) into notional exposure. 1 for
    // spot strategies, so this reduces to the old margin-free formula.
    const leverage = this.strategyDoc.riskLimits.maxLeverage;
    const notional = freeCapital.mul(leverage);
    const quantity = notional.div(price);

    const orderId = new ObjectId();
    const clientOrderId = `paper-${orderId.toHexString()}`;
    const orderSide = side === "LONG" ? "BUY" : "SELL";

    await ordersCollection(this.db).insertOne({
      _id: orderId,
      strategyId: this.strategyDoc._id,
      clientOrderId,
      symbol: candle.symbol,
      side: orderSide,
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
      side: orderSide,
      quantity: quantity.toString(),
    });

    // Reserved *after* the intent is written but *before* the broker call —
    // the outbox record exists either way if this crashes mid-call.
    await this.capitalLedger.reserve(this.strategyDoc, freeCapital, `enter_${side.toLowerCase()}`, orderId);

    const result = await this.broker.placeOrder({
      clientOrderId,
      symbol: candle.symbol,
      side: orderSide,
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

    const entryFee = result.fills.reduce((sum, fill) => sum.plus(toDecimalJs(fill.commission)), new Decimal(0));

    this.openPosition = {
      side,
      quantity: toDecimalJs(result.executedQuantity),
      entryPrice: price,
      marginReserved: freeCapital,
      entryFee,
      entryOrderId: orderId,
      entryTime: candle.closeTime,
    };

    await this.audit("ORDER_FILLED", {
      orderId: orderId.toHexString(),
      side: orderSide,
      price: price.toString(),
      quantity: result.executedQuantity.toString(),
    });
  }

  private async exitPosition(candle: Candle): Promise<void> {
    const position = this.openPosition;
    if (!position) {
      return;
    }

    const orderId = new ObjectId();
    const clientOrderId = `paper-${orderId.toHexString()}`;
    // Closing a long sells; closing a short buys back.
    const orderSide = position.side === "LONG" ? "SELL" : "BUY";

    await ordersCollection(this.db).insertOne({
      _id: orderId,
      strategyId: this.strategyDoc._id,
      clientOrderId,
      symbol: candle.symbol,
      side: orderSide,
      type: "MARKET",
      quantity: fromDecimalJs(position.quantity),
      status: "PENDING_INTENT",
      executedQuantity: fromDecimalJs(new Decimal(0)),
      cumulativeQuoteQuantity: fromDecimalJs(new Decimal(0)),
      fills: [],
      reduceOnly: true,
      intentCreatedAt: new Date(),
      updatedAt: new Date(),
    });
    await this.audit("ORDER_INTENT", {
      orderId: orderId.toHexString(),
      side: orderSide,
      quantity: position.quantity.toString(),
    });

    const result = await this.broker.placeOrder({
      clientOrderId,
      symbol: candle.symbol,
      side: orderSide,
      type: "MARKET",
      quantity: fromDecimalJs(position.quantity),
      reduceOnly: true,
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

    const executedQuantity = toDecimalJs(result.executedQuantity);
    // Volume-weighted average fill price, not just the first fill's price.
    const exitPrice = executedQuantity.isZero()
      ? position.entryPrice
      : toDecimalJs(result.cumulativeQuoteQuantity).div(executedQuantity);
    const exitFee = result.fills.reduce((sum, fill) => sum.plus(toDecimalJs(fill.commission)), new Decimal(0));
    const totalFees = position.entryFee.plus(exitFee);

    const realizedPnl =
      position.side === "LONG"
        ? exitPrice.minus(position.entryPrice).mul(position.quantity)
        : position.entryPrice.minus(exitPrice).mul(position.quantity);
    const netPnl = realizedPnl.minus(totalFees);
    // % return on margin, not on notional — with leverage those are very
    // different numbers, and margin-based ROI is what the trader actually
    // risked. Reduces to the old spot formula when leverage is 1.
    const pnlPct = position.marginReserved.isZero() ? new Decimal(0) : netPnl.div(position.marginReserved).mul(100);

    await tradesCollection(this.db).insertOne({
      _id: new ObjectId(),
      strategyId: this.strategyDoc._id,
      symbol: candle.symbol,
      side: position.side,
      entryOrderIds: [position.entryOrderId],
      exitOrderIds: [orderId],
      entryPrice: fromDecimalJs(position.entryPrice),
      exitPrice: fromDecimalJs(exitPrice),
      quantity: fromDecimalJs(position.quantity),
      leverage: this.strategyDoc.riskLimits.maxLeverage,
      pnl: fromDecimalJs(netPnl),
      pnlPct: pnlPct.toNumber(),
      feesPaid: fromDecimalJs(totalFees),
      feeAsset: result.fills[0]?.commissionAsset ?? "",
      // Not computed yet — see the Trade model's comment on this field.
      fundingFeesPaid: fromDecimalJs(new Decimal(0)),
      entryTime: position.entryTime,
      exitTime: candle.closeTime,
      durationMs: candle.closeTime.getTime() - position.entryTime.getTime(),
      closeReason: "signal",
    });

    // Margin originally reserved, adjusted by the net PnL — not the sale
    // proceeds spot used to compute, since a futures position was never
    // literally bought/sold as inventory.
    const releaseAmount = position.marginReserved.plus(netPnl);
    await this.capitalLedger.release(this.strategyDoc, releaseAmount, `exit_${position.side.toLowerCase()}`, orderId);
    this.openPosition = null;

    await this.audit("ORDER_FILLED", {
      orderId: orderId.toHexString(),
      side: orderSide,
      pnl: netPnl.toString(),
    });

    // Phase 6 circuit breaker: riskLimits.maxDrawdownPct has existed on the
    // schema since Phase 1 but was never enforced until now.
    const breached = await checkDrawdownBreaker(this.db, this.strategyDoc);
    if (breached) {
      await this.audit("KILL_SWITCH", {
        reason: "max_drawdown_breached",
        limitPct: this.strategyDoc.riskLimits.maxDrawdownPct,
      });
    }
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
    // Same call site as the Mongo write (audit_log is the durable record,
    // this is just the live feed) — every DECISION/ORDER_INTENT/
    // ORDER_FILLED/RISK_BLOCK reaches the dashboard exactly where it
    // reaches Mongo, nothing to keep in sync separately.
    await this.publisher?.publish({
      type: eventType,
      strategyId: this.strategyDoc._id.toHexString(),
      strategySlug: this.strategyDoc.slug,
      payload,
    });
  }
}
