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

  // Call once, right after construction and before the candle stream
  // starts. Reconciles in-memory position state against the real exchange
  // when the broker supports it (see Broker.getOpenPosition), instead of
  // always assuming flat — the property this restores is enterPosition's
  // `!this.openPosition` guard (and therefore "only one open position per
  // strategy") staying true across a process restart, not just within one
  // continuous run. PaperBroker doesn't implement getOpenPosition, so this
  // is a no-op for paper strategies — nothing to recover, positions are
  // ephemeral there by construction.
  //
  // The recovered position's fee/margin/entry-time bookkeeping is
  // necessarily approximate: a position-risk query returns current state,
  // not the original order's details, which aren't recoverable this way.
  async initialize(): Promise<void> {
    if (!this.broker.getOpenPosition) {
      return;
    }
    const symbol = this.strategyDoc.symbols[0];
    const real = await this.broker.getOpenPosition(symbol);
    if (!real) {
      return;
    }

    console.warn(
      `[strategy:${this.strategyDoc.slug}] found a real open ${real.side} position on the exchange at startup ` +
        `(qty ${real.quantity.toString()} @ ${real.entryPrice.toString()}) — recovering it so a new entry can't ` +
        `stack on top of it.`,
    );

    const entryPrice = toDecimalJs(real.entryPrice);
    const quantity = toDecimalJs(real.quantity);
    const leverage = this.strategyDoc.riskLimits.maxLeverage;
    this.openPosition = {
      side: real.side,
      quantity,
      entryPrice,
      marginReserved: leverage > 0 ? quantity.mul(entryPrice).div(leverage) : quantity.mul(entryPrice),
      entryFee: new Decimal(0),
      entryOrderId: new ObjectId(),
      entryTime: new Date(),
    };

    await this.audit("POSITION_RECOVERED", {
      side: real.side,
      quantity: real.quantity.toString(),
      entryPrice: real.entryPrice.toString(),
    });
  }

  // Used by the dashboard's disable control — refuses to tear down a
  // strategy's runner while it holds a real position, since stopping the
  // stream/runner would abandon that position's exit management entirely
  // (no more stop checks, no more reversal signals) with nothing left
  // watching it.
  hasOpenPosition(): boolean {
    return this.openPosition !== null;
  }

  async onCandle(candle: Candle): Promise<void> {
    const positionState: StrategyPositionState = {
      isOpen: this.openPosition !== null,
      side: this.openPosition?.side ?? null,
      quantity: fromDecimalJs(this.openPosition?.quantity ?? new Decimal(0)),
    };

    const { signal, riskFraction, forceReenter } = this.algorithm.decide(candle, positionState);
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
      // it, one direction becomes structurally unreachable. forceReenter
      // additionally closes-then-reopens when the SAME side is already
      // open — see StrategyDecision.forceReenter's doc comment for why an
      // algorithm needs that (btc-high-risk's same-bar stop-then-reenter).
      if (signal === "ENTER_LONG") {
        const alreadyLong = positionState.isOpen && positionState.side === "LONG";
        if ((positionState.isOpen && positionState.side === "SHORT") || (alreadyLong && forceReenter)) {
          await this.exitPosition(candle);
        }
        if (!this.openPosition) {
          await this.enterPosition("LONG", candle, riskFraction);
        }
      } else if (signal === "ENTER_SHORT") {
        const alreadyShort = positionState.isOpen && positionState.side === "SHORT";
        if ((positionState.isOpen && positionState.side === "LONG") || (alreadyShort && forceReenter)) {
          await this.exitPosition(candle);
        }
        if (!this.openPosition) {
          await this.enterPosition("SHORT", candle, riskFraction);
        }
      } else if (signal === "EXIT_LONG" && positionState.isOpen && positionState.side === "LONG") {
        await this.exitPosition(candle);
      } else if (signal === "EXIT_SHORT" && positionState.isOpen && positionState.side === "SHORT") {
        await this.exitPosition(candle);
      }
    } catch (error) {
      // A single candle's processing must never take down the whole
      // engine process — every other strategy runs in this same process
      // (see CLAUDE.md's "one supervised worker per strategy... a
      // crash/error in one restarts that worker, not the others": an
      // uncaught error here previously violated exactly that guarantee,
      // since Node terminates the whole process on an unhandled rejection
      // by default. Found live: a transient Mongo connectivity blip during
      // an audit-log write crashed the entire engine, both demo strategies
      // included, during an otherwise-healthy overnight run. Logged and
      // swallowed here instead — this candle's action is lost, but the
      // strategy (and every other one sharing this process) keeps running
      // for the next candle rather than requiring a manual restart.
      console.error(`[strategy:${this.strategyDoc.slug}] onCandle failed, continuing:`, (error as Error).message);
    } finally {
      this.busy = false;
    }
  }

  private async enterPosition(side: PositionSide, candle: Candle, riskFraction?: number): Promise<void> {
    this.riskManager.checkCanEnter(this.strategyDoc);

    const freeCapital = await this.capitalLedger.getFreeCapital(this.strategyDoc);
    if (freeCapital.lessThanOrEqualTo(0)) {
      await this.audit("RISK_BLOCK", { reason: "no free capital", strategy: this.strategyDoc.slug });
      return;
    }

    // riskFraction lets an algorithm reserve only part of free capital as
    // margin (e.g. btc-high-risk sizes 0.5%-2% of equity per Fib level)
    // instead of always spending everything available on one trade —
    // undefined preserves the original "use it all" behavior.
    const marginToUse = riskFraction === undefined ? freeCapital : freeCapital.mul(riskFraction);

    const price = toDecimalJs(candle.close);
    // Leverage turns margin into notional exposure. 1 for spot strategies,
    // so this reduces to the old margin-free formula.
    const leverage = this.strategyDoc.riskLimits.maxLeverage;
    const notional = marginToUse.mul(leverage);
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
    await this.capitalLedger.reserve(this.strategyDoc, marginToUse, `enter_${side.toLowerCase()}`, orderId);

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
      marginReserved: marginToUse,
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
    // Fail-open, matching EventPublisher.publish()'s existing behavior for
    // the same call site — audit_log is an observability record, not the
    // outbox itself (orders/trades/capital_ledger writes elsewhere in this
    // file are the ones that must not silently fail). A transient Mongo
    // hiccup here should cost an audit entry, not abort whatever order
    // action this call is bracketing (some audit() calls happen *after* a
    // real fill, e.g. ORDER_FILLED — losing that log line is fine; losing
    // track of the fill itself would not be).
    try {
      await auditLogCollection(this.db).insertOne({
        _id: new ObjectId(),
        strategyId: this.strategyDoc._id,
        eventType,
        source: "engine",
        payload,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error(`[strategy:${this.strategyDoc.slug}] audit log write failed:`, (error as Error).message);
    }
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
