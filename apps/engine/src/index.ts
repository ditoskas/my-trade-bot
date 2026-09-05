import { ObjectId, type Db } from "mongodb";
import {
  closeMongo,
  connectMongo,
  ensureIndexes,
  strategiesCollection,
  toDecimal128,
  tradesCollection,
  type Strategy,
} from "@trade-bot/shared";
import { PaperBroker } from "./broker/paperBroker.js";
import type { Candle } from "./broker/types.js";
import { fetchHistoricalCandles } from "./marketData/binancePublic.js";
import { generateSyntheticCandles } from "./marketData/syntheticCandles.js";
import { CapitalLedger } from "./risk/capitalLedger.js";
import { RiskManager } from "./risk/riskManager.js";
import { MovingAverageCrossStrategy } from "./strategy/movingAverageCross.js";
import { StrategyRunner } from "./strategyRunner.js";

// Phase 2 proof-of-pipeline run: load real (or, if unreachable, synthetic)
// candles, feed them through one paper strategy, print the resulting
// trades. Phase 3 replaces the one-shot candle load with a live WebSocket
// feed and swaps PaperBroker for BinanceBroker; Phase 4/5 add the dashboard
// and chatops on top. See CLAUDE.md for the full phase plan.

const SYMBOL = "BTCUSDT";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/trade-bot-dev";

async function getOrCreateDemoStrategy(db: Db): Promise<Strategy> {
  const slug = "ma-cross-demo";
  const existing = await strategiesCollection(db).findOne({ slug });
  if (existing) {
    return existing;
  }

  const doc: Strategy = {
    _id: new ObjectId(),
    slug,
    name: "MA Cross Demo (paper)",
    description: "Phase 2 proof-of-pipeline strategy — 5/20 period SMA cross on BTCUSDT.",
    version: 1,
    lifecycleState: "paper",
    broker: "paper",
    symbols: [SYMBOL],
    allocatedCapital: toDecimal128("1000"),
    allocatedCapitalAsset: "USDT",
    riskLimits: {
      maxPositionSize: toDecimal128("1000"),
      maxConcurrentPositions: 1,
      maxDrawdownPct: 20,
    },
    config: { fastPeriod: 5, slowPeriod: 20 },
    killSwitchEngaged: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await strategiesCollection(db).insertOne(doc);
  return doc;
}

async function loadCandles(): Promise<Candle[]> {
  try {
    const candles = await fetchHistoricalCandles(SYMBOL, "1h", 200);
    console.log(`[engine] loaded ${candles.length} real ${SYMBOL} candles from Binance's public API`);
    return candles;
  } catch (error) {
    console.warn(
      `[engine] couldn't reach Binance's public API (${(error as Error).message}) — using synthetic candles instead`,
    );
    return generateSyntheticCandles(SYMBOL, 200);
  }
}

async function main(): Promise<void> {
  const connection = await connectMongo(MONGODB_URI);
  const { db } = connection;

  try {
    await ensureIndexes(db);
    const strategyDoc = await getOrCreateDemoStrategy(db);

    const broker = new PaperBroker();
    const runner = new StrategyRunner(
      db,
      strategyDoc,
      new MovingAverageCrossStrategy(SYMBOL, 5, 20),
      broker,
      new RiskManager(),
      new CapitalLedger(db),
    );

    const candles = await loadCandles();
    for (const candle of candles) {
      broker.setPrice(candle.symbol, candle.close);
      await runner.onCandle(candle);
    }

    const trades = await tradesCollection(db)
      .find({ strategyId: strategyDoc._id })
      .sort({ exitTime: 1 })
      .toArray();

    console.log(`[engine] pipeline run complete — ${trades.length} closed trade(s) for "${strategyDoc.slug}"`);
    for (const trade of trades) {
      console.log(
        `  ${trade.entryTime.toISOString()} -> ${trade.exitTime.toISOString()}` +
          ` | qty ${trade.quantity.toString()} | pnl ${trade.pnl.toString()} (${trade.pnlPct.toFixed(2)}%)`,
      );
    }
  } finally {
    await closeMongo(connection);
  }
}

main().catch((error: unknown) => {
  console.error("[engine] fatal error:", error);
  process.exitCode = 1;
});
