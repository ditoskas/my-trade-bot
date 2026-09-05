import { strategiesCollection } from "@trade-bot/shared";
import { getMongo } from "@/lib/mongo";
import type { StrategySummary } from "@/lib/types";
import { StrategyList } from "./StrategyList";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { db } = await getMongo();
  const strategies = await strategiesCollection(db).find({}).sort({ slug: 1 }).toArray();

  const summaries: StrategySummary[] = strategies.map((strategy) => ({
    slug: strategy.slug,
    name: strategy.name,
    description: strategy.description,
    symbols: strategy.symbols,
    broker: strategy.broker,
    lifecycleState: strategy.lifecycleState,
    killSwitchEngaged: strategy.killSwitchEngaged,
    allocatedCapital: strategy.allocatedCapital.toString(),
    allocatedCapitalAsset: strategy.allocatedCapitalAsset,
    maxLeverage: strategy.riskLimits.maxLeverage,
  }));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Strategies</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Live status via server-sent events — no page refresh needed.
      </p>
      {summaries.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-400">
          No strategies yet — start the engine (<code className="font-mono">apps/engine</code>) to seed the demo
          strategies.
        </p>
      ) : (
        <StrategyList initialStrategies={summaries} />
      )}
    </main>
  );
}
