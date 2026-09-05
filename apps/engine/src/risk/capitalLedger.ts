import { ObjectId, type Db } from "mongodb";
import { Decimal } from "decimal.js";
import { capitalLedgerCollection, fromDecimalJs, toDecimalJs, type Strategy } from "@trade-bot/shared";

export class InsufficientCapitalError extends Error {}

// Tracks each strategy's free (unreserved) capital as an append-only ledger
// so order sizing never assumes more than is actually available — this is
// what stops two strategies double-spending the same balance (see
// CLAUDE.md's Capital Ledger section).
//
// Known limitation: getFreeCapital() reads the last entry and reserve()/
// release() then insert a new one — a classic check-then-act race if two
// reservations for the *same* strategy happen concurrently. Fine for one
// strategy at a time (Phase 2); needs an atomic findOneAndUpdate on a
// running-balance field, or a Mongo transaction, before running multiple
// concurrent strategies.
export class CapitalLedger {
  constructor(private readonly db: Db) {}

  async getFreeCapital(strategy: Strategy): Promise<Decimal> {
    const last = await capitalLedgerCollection(this.db)
      .find({ strategyId: strategy._id })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    return last ? toDecimalJs(last.balanceAfter) : toDecimalJs(strategy.allocatedCapital);
  }

  async reserve(strategy: Strategy, amount: Decimal, reason: string, relatedOrderId?: ObjectId): Promise<void> {
    const free = await this.getFreeCapital(strategy);
    if (free.lessThan(amount)) {
      throw new InsufficientCapitalError(
        `strategy ${strategy.slug}: tried to reserve ${amount.toString()} but only ${free.toString()} is free`,
      );
    }
    await this.record(strategy, "RESERVE", amount, free.minus(amount), reason, relatedOrderId);
  }

  async release(strategy: Strategy, amount: Decimal, reason: string, relatedOrderId?: ObjectId): Promise<void> {
    const free = await this.getFreeCapital(strategy);
    await this.record(strategy, "RELEASE", amount, free.plus(amount), reason, relatedOrderId);
  }

  private async record(
    strategy: Strategy,
    type: "RESERVE" | "RELEASE",
    amount: Decimal,
    balanceAfter: Decimal,
    reason: string,
    relatedOrderId?: ObjectId,
  ): Promise<void> {
    await capitalLedgerCollection(this.db).insertOne({
      _id: new ObjectId(),
      strategyId: strategy._id,
      type,
      amount: fromDecimalJs(amount),
      asset: strategy.allocatedCapitalAsset,
      relatedOrderId,
      balanceAfter: fromDecimalJs(balanceAfter),
      reason,
      createdAt: new Date(),
    });
  }
}
