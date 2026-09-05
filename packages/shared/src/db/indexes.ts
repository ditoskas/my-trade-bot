import type { Db } from "mongodb";
import { COLLECTION_NAMES } from "./collections";

// Idempotent — safe to call on every app startup, not just once.
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection(COLLECTION_NAMES.strategies).createIndexes([
    { key: { slug: 1 }, unique: true, name: "uniq_slug" },
    { key: { lifecycleState: 1 }, name: "lifecycleState" },
  ]);

  await db.collection(COLLECTION_NAMES.orders).createIndexes([
    // Enforces the idempotency guarantee at the DB level, not just in code.
    { key: { clientOrderId: 1 }, unique: true, name: "uniq_clientOrderId" },
    { key: { strategyId: 1, status: 1 }, name: "strategy_status" },
    { key: { symbol: 1, updatedAt: -1 }, name: "symbol_updatedAt" },
  ]);

  await db.collection(COLLECTION_NAMES.trades).createIndexes([
    { key: { strategyId: 1, exitTime: -1 }, name: "strategy_exitTime" },
    { key: { symbol: 1, exitTime: -1 }, name: "symbol_exitTime" },
  ]);

  await db.collection(COLLECTION_NAMES.equitySnapshots).createIndexes([
    { key: { strategyId: 1, timestamp: -1 }, name: "strategy_timestamp" },
  ]);

  await db.collection(COLLECTION_NAMES.capitalLedger).createIndexes([
    { key: { strategyId: 1, createdAt: -1 }, name: "strategy_createdAt" },
  ]);

  await db.collection(COLLECTION_NAMES.auditLog).createIndexes([
    { key: { strategyId: 1, timestamp: -1 }, name: "strategy_timestamp" },
    { key: { eventType: 1, timestamp: -1 }, name: "eventType_timestamp" },
  ]);

  await db.collection(COLLECTION_NAMES.commands).createIndexes([
    { key: { status: 1, createdAt: 1 }, name: "status_createdAt" },
  ]);
}
