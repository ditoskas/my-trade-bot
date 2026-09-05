import { Spot, SPOT_REST_API_PROD_URL, SPOT_REST_API_TESTNET_URL } from "@binance/spot";
import { Decimal } from "decimal.js";
import { ObjectId, type Db } from "mongodb";
import { auditLogCollection, ordersCollection, strategiesCollection } from "@trade-bot/shared";
import { CapitalLedger } from "../risk/capitalLedger";

export interface ReconciliationOptions {
  apiKey: string;
  apiSecret: string;
  useTestnet?: boolean;
}

export type ReconciliationMismatch =
  | { type: "OPEN_ORDER_MISSING_ON_EXCHANGE"; clientOrderId: string; mongoStatus: string }
  | { type: "OPEN_ORDER_MISSING_IN_MONGO"; clientOrderId: string; exchangeStatus?: string }
  | { type: "BALANCE_MISMATCH"; asset: string; ledgerFree: string; exchangeFree: string };

// Diffs Mongo's view of account state against Binance's actual state — see
// CLAUDE.md's Engine section: "a reconciliation job... alerts loudly on
// mismatch." Read-only: never cancels an order or adjusts the ledger, only
// reports discrepancies for a human (or Phase 5's chatops) to act on.
export async function reconcile(db: Db, options: ReconciliationOptions): Promise<ReconciliationMismatch[]> {
  const client = new Spot({
    configurationRestAPI: {
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      basePath: options.useTestnet ? SPOT_REST_API_TESTNET_URL : SPOT_REST_API_PROD_URL,
    },
  });

  const mismatches: ReconciliationMismatch[] = [];

  await checkOpenOrders(db, client, mismatches);
  await checkBalances(db, client, mismatches);

  if (mismatches.length > 0) {
    await auditLogCollection(db).insertOne({
      _id: new ObjectId(),
      strategyId: null,
      eventType: "RECONCILIATION_MISMATCH",
      source: "engine",
      payload: { mismatches },
      timestamp: new Date(),
    });
  }

  return mismatches;
}

async function checkOpenOrders(db: Db, client: Spot, mismatches: ReconciliationMismatch[]): Promise<void> {
  const exchangeResponse = await client.restAPI.getOpenOrders();
  const exchangeOpenOrders = await exchangeResponse.data();
  const exchangeClientOrderIds = new Set(exchangeOpenOrders.map((order) => order.clientOrderId));

  const mongoOpenOrders = await ordersCollection(db)
    .find({ status: { $in: ["SUBMITTED", "PARTIALLY_FILLED"] } })
    .toArray();

  for (const order of mongoOpenOrders) {
    if (!exchangeClientOrderIds.has(order.clientOrderId)) {
      mismatches.push({
        type: "OPEN_ORDER_MISSING_ON_EXCHANGE",
        clientOrderId: order.clientOrderId,
        mongoStatus: order.status,
      });
    }
  }

  const mongoClientOrderIds = new Set(mongoOpenOrders.map((order) => order.clientOrderId));
  for (const exchangeOrder of exchangeOpenOrders) {
    if (exchangeOrder.clientOrderId && !mongoClientOrderIds.has(exchangeOrder.clientOrderId)) {
      mismatches.push({
        type: "OPEN_ORDER_MISSING_IN_MONGO",
        clientOrderId: exchangeOrder.clientOrderId,
        exchangeStatus: exchangeOrder.status,
      });
    }
  }
}

// Sanity check, not a precise reconciliation: sums each active strategy's
// free ledger capital per asset and flags it only if that *exceeds* the
// exchange's real free balance — i.e. the ledger believes more is
// available than actually exists. The reverse (exchange has more free than
// the ledger accounts for) is expected whenever capital hasn't been
// allocated to a strategy yet, so it's not flagged.
async function checkBalances(db: Db, client: Spot, mismatches: ReconciliationMismatch[]): Promise<void> {
  const accountResponse = await client.restAPI.getAccount();
  const account = await accountResponse.data();
  const exchangeFreeByAsset = new Map<string, Decimal>(
    (account.balances ?? []).map((balance) => [balance.asset ?? "", new Decimal(balance.free ?? "0")]),
  );

  const capitalLedger = new CapitalLedger(db);
  const activeStrategies = await strategiesCollection(db)
    .find({ lifecycleState: { $nin: ["retired", "draft"] } })
    .toArray();

  const ledgerFreeByAsset = new Map<string, Decimal>();
  for (const strategy of activeStrategies) {
    const free = await capitalLedger.getFreeCapital(strategy);
    const running = ledgerFreeByAsset.get(strategy.allocatedCapitalAsset) ?? new Decimal(0);
    ledgerFreeByAsset.set(strategy.allocatedCapitalAsset, running.plus(free));
  }

  for (const [asset, ledgerFree] of ledgerFreeByAsset) {
    const exchangeFree = exchangeFreeByAsset.get(asset) ?? new Decimal(0);
    if (ledgerFree.greaterThan(exchangeFree)) {
      mismatches.push({
        type: "BALANCE_MISMATCH",
        asset,
        ledgerFree: ledgerFree.toString(),
        exchangeFree: exchangeFree.toString(),
      });
    }
  }
}
