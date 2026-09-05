import type { Collection, Db } from "mongodb";
import type { Strategy } from "../models/strategy";
import type { Order } from "../models/order";
import type { Trade } from "../models/trade";
import type { EquitySnapshot } from "../models/equitySnapshot";
import type { CapitalLedgerEntry } from "../models/capitalAllocation";
import type { AuditLogEntry } from "../models/auditLog";
import type { ChatopsCommand } from "../models/command";

export const COLLECTION_NAMES = {
  strategies: "strategies",
  orders: "orders",
  trades: "trades",
  equitySnapshots: "equity_snapshots",
  capitalLedger: "capital_allocations",
  auditLog: "audit_log",
  commands: "commands",
} as const;

export function strategiesCollection(db: Db): Collection<Strategy> {
  return db.collection<Strategy>(COLLECTION_NAMES.strategies);
}

export function ordersCollection(db: Db): Collection<Order> {
  return db.collection<Order>(COLLECTION_NAMES.orders);
}

export function tradesCollection(db: Db): Collection<Trade> {
  return db.collection<Trade>(COLLECTION_NAMES.trades);
}

export function equitySnapshotsCollection(db: Db): Collection<EquitySnapshot> {
  return db.collection<EquitySnapshot>(COLLECTION_NAMES.equitySnapshots);
}

export function capitalLedgerCollection(db: Db): Collection<CapitalLedgerEntry> {
  return db.collection<CapitalLedgerEntry>(COLLECTION_NAMES.capitalLedger);
}

export function auditLogCollection(db: Db): Collection<AuditLogEntry> {
  return db.collection<AuditLogEntry>(COLLECTION_NAMES.auditLog);
}

export function commandsCollection(db: Db): Collection<ChatopsCommand> {
  return db.collection<ChatopsCommand>(COLLECTION_NAMES.commands);
}
