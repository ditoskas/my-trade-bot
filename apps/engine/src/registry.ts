import type { Db } from "mongodb";
import { strategiesCollection, type Strategy } from "@trade-bot/shared";
import type { BinanceKlineStream } from "./marketData/binanceKlineStream";
import type { StrategyRunner } from "./strategyRunner";

export interface RegisteredStrategy {
  doc: Strategy;
  runner: StrategyRunner;
  stream: BinanceKlineStream;
}

// Holds every running strategy's live, mutable state. The control API
// mutates `doc` fields in place (and persists to Mongo) rather than
// replacing the object — StrategyRunner holds a reference to this same
// Strategy instance and reads its fields fresh on every candle (see
// RiskManager.checkCanEnter), so a pause/kill takes effect on the very
// next candle without restarting anything.
export class StrategyRegistry {
  private readonly strategies = new Map<string, RegisteredStrategy>();

  constructor(private readonly db: Db) {}

  register(entry: RegisteredStrategy): void {
    this.strategies.set(entry.doc.slug, entry);
  }

  get(slug: string): RegisteredStrategy | undefined {
    return this.strategies.get(slug);
  }

  list(): RegisteredStrategy[] {
    return [...this.strategies.values()];
  }

  async setLifecycleState(slug: string, state: Strategy["lifecycleState"]): Promise<boolean> {
    const entry = this.strategies.get(slug);
    if (!entry) {
      return false;
    }
    entry.doc.lifecycleState = state;
    entry.doc.updatedAt = new Date();
    await strategiesCollection(this.db).updateOne(
      { _id: entry.doc._id },
      { $set: { lifecycleState: state, updatedAt: entry.doc.updatedAt } },
    );
    return true;
  }

  async setKillSwitch(slug: string, engaged: boolean): Promise<boolean> {
    const entry = this.strategies.get(slug);
    if (!entry) {
      return false;
    }
    entry.doc.killSwitchEngaged = engaged;
    entry.doc.updatedAt = new Date();
    await strategiesCollection(this.db).updateOne(
      { _id: entry.doc._id },
      { $set: { killSwitchEngaged: engaged, updatedAt: entry.doc.updatedAt } },
    );
    return true;
  }

  stopAll(): void {
    for (const entry of this.strategies.values()) {
      entry.stream.stop();
    }
  }
}
