import Link from "next/link";
import { notFound } from "next/navigation";
import { auditLogCollection, computeStrategyStats, strategiesCollection, tradesCollection } from "@trade-bot/shared";
import { getMongo } from "@/lib/mongo";
import type { DecisionLogEntrySummary, TradeSummary } from "@/lib/types";
import { StrategyControls } from "./StrategyControls";
import { StrategyLogTabs } from "./StrategyLogTabs";

// Cap on how many decision-log rows a strategy detail page fetches —
// audit_log grows one DECISION entry per non-HOLD signal (plus
// ORDER_INTENT/FILLED/RISK_BLOCK/etc.) for as long as the strategy has
// been enabled, so an unbounded query could return an unbounded page.
const DECISION_LOG_LIMIT = 300;

export const dynamic = "force-dynamic";

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="text-xs uppercase text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-50">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{hint}</div>}
    </div>
  );
}

export default async function StrategyDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { db } = await getMongo();

  const strategy = await strategiesCollection(db).findOne({ slug });
  if (!strategy) {
    notFound();
  }

  const trades = await tradesCollection(db).find({ strategyId: strategy._id }).sort({ exitTime: -1 }).toArray();
  const stats = computeStrategyStats(trades, strategy.allocatedCapital);

  const auditEntries = await auditLogCollection(db)
    .find({ strategyId: strategy._id })
    .sort({ timestamp: -1 })
    .limit(DECISION_LOG_LIMIT)
    .toArray();
  const decisionLogTruncated = auditEntries.length === DECISION_LOG_LIMIT;

  const decisionLogSummaries: DecisionLogEntrySummary[] = auditEntries.map((entry) => ({
    id: entry._id.toHexString(),
    eventType: entry.eventType,
    source: entry.source,
    payload: entry.payload,
    timestamp: entry.timestamp.toISOString(),
  }));

  const tradeSummaries: TradeSummary[] = trades.map((trade) => ({
    id: trade._id.toHexString(),
    symbol: trade.symbol,
    side: trade.side,
    entryPrice: trade.entryPrice.toString(),
    exitPrice: trade.exitPrice.toString(),
    quantity: trade.quantity.toString(),
    leverage: trade.leverage,
    pnl: trade.pnl.toString(),
    pnlPct: trade.pnlPct,
    feesPaid: trade.feesPaid.toString(),
    entryTime: trade.entryTime.toISOString(),
    exitTime: trade.exitTime.toISOString(),
    closeReason: trade.closeReason,
  }));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
        ← Strategies
      </Link>
      <div className="mt-2 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{strategy.name}</h1>
          {strategy.description && (
            <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">{strategy.description}</p>
          )}
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            {strategy.symbols.join(", ")} · {strategy.broker} · {strategy.allocatedCapital.toString()}{" "}
            {strategy.allocatedCapitalAsset} allocated · {strategy.riskLimits.maxLeverage}x leverage
          </p>
        </div>
        <StrategyControls
          slug={strategy.slug}
          initialLifecycleState={strategy.lifecycleState}
          initialKillSwitchEngaged={strategy.killSwitchEngaged}
          initialEnabled={strategy.enabled}
        />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Trades" value={String(stats.totalTrades)} />
        <StatCard label="Win rate" value={`${stats.winRate.toFixed(1)}%`} />
        <StatCard
          label="Profit factor"
          value={stats.profitFactor === null ? "—" : stats.profitFactor.toFixed(2)}
          hint={stats.profitFactor === null ? "no losing trades yet" : undefined}
        />
        <StatCard label="Max drawdown" value={`${stats.maxDrawdownPct.toFixed(1)}%`} hint="of allocated capital" />
        <StatCard
          label="Sharpe-like"
          value={stats.sharpeLike === null ? "—" : stats.sharpeLike.toFixed(2)}
          hint="not annualized"
        />
        <StatCard
          label="Total PnL"
          value={`${stats.totalPnl} ${strategy.allocatedCapitalAsset}`}
          hint={`fees paid: ${stats.totalFeesPaid}`}
        />
      </div>

      <StrategyLogTabs
        trades={tradeSummaries}
        decisionLog={decisionLogSummaries}
        decisionLogTruncated={decisionLogTruncated}
      />
    </main>
  );
}
