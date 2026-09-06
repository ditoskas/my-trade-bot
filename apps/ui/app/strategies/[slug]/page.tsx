import Link from "next/link";
import { notFound } from "next/navigation";
import { computeStrategyStats, strategiesCollection, tradesCollection } from "@trade-bot/shared";
import { getMongo } from "@/lib/mongo";
import type { TradeSummary } from "@/lib/types";
import { StrategyControls } from "./StrategyControls";

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

      <h2 className="mt-10 text-lg font-semibold text-zinc-900 dark:text-zinc-50">Trade log</h2>
      {tradeSummaries.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No closed trades yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-3">Side</th>
                <th className="px-4 py-3">Entry</th>
                <th className="px-4 py-3">Exit</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Lev.</th>
                <th className="px-4 py-3">PnL</th>
                <th className="px-4 py-3">Fees</th>
                <th className="px-4 py-3">Closed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {tradeSummaries.map((trade) => (
                <tr key={trade.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <td className="px-4 py-3">
                    <span
                      className={
                        trade.side === "LONG"
                          ? "rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                          : "rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-950 dark:text-orange-400"
                      }
                    >
                      {trade.side}
                    </span>
                  </td>
                  <td className="px-4 py-3">{trade.entryPrice}</td>
                  <td className="px-4 py-3">{trade.exitPrice}</td>
                  <td className="px-4 py-3">{trade.quantity}</td>
                  <td className="px-4 py-3">{trade.leverage}x</td>
                  <td
                    className={`px-4 py-3 font-medium ${
                      Number(trade.pnl) >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {trade.pnl} ({trade.pnlPct.toFixed(2)}%)
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{trade.feesPaid}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                    {new Date(trade.exitTime).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
