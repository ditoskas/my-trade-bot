import { computeStrategyStats, strategiesCollection, tradesCollection, type Strategy } from "@trade-bot/shared";
import type { Db } from "mongodb";

// Circuit breaker (Phase 6): after any trade closes, checks whether the
// strategy's realized max drawdown has breached its own configured limit
// (riskLimits.maxDrawdownPct) — a field that's existed on the schema since
// Phase 1 but was never actually enforced until now. Engages the kill
// switch if breached. Returns whether it just engaged it (false if already
// engaged, or not breached).
//
// Mutates strategyDoc in place — same pattern as StrategyRegistry's
// control-API actions — so a running StrategyRunner (which holds this same
// object reference) observes the kill switch on its very next candle.
export async function checkDrawdownBreaker(db: Db, strategyDoc: Strategy): Promise<boolean> {
  if (strategyDoc.killSwitchEngaged) {
    return false;
  }

  const trades = await tradesCollection(db).find({ strategyId: strategyDoc._id }).toArray();
  const stats = computeStrategyStats(trades, strategyDoc.allocatedCapital);

  if (stats.maxDrawdownPct < strategyDoc.riskLimits.maxDrawdownPct) {
    return false;
  }

  strategyDoc.killSwitchEngaged = true;
  strategyDoc.updatedAt = new Date();
  await strategiesCollection(db).updateOne(
    { _id: strategyDoc._id },
    { $set: { killSwitchEngaged: true, updatedAt: strategyDoc.updatedAt } },
  );
  return true;
}
