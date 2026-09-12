"use client";

import { useState } from "react";
import type { DecisionLogEntrySummary, TradeSummary } from "@/lib/types";

interface Props {
  trades: TradeSummary[];
  decisionLog: DecisionLogEntrySummary[];
  decisionLogTruncated: boolean;
}

const EVENT_BADGE_CLASS: Record<string, string> = {
  DECISION: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  ORDER_INTENT: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  ORDER_SUBMITTED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  ORDER_FILLED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  RISK_BLOCK: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  KILL_SWITCH: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  RECONCILIATION_MISMATCH: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  COMMAND: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
  POSITION_RECOVERED: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-400",
  ENABLED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  DISABLED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

function formatPayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
}

// Pinned to "en-US" rather than the runtime default locale — this is a
// Client Component that's also server-rendered, and Node's default locale
// on the server doesn't necessarily match the browser's locale, which
// produces a hydration mismatch (React re-renders the whole subtree once
// it notices, which is wasted work and a console error, not just cosmetic).
function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US");
}

export function StrategyLogTabs({ trades, decisionLog, decisionLogTruncated }: Props) {
  const [tab, setTab] = useState<"trades" | "decisions">("trades");

  const tabButtonClass = (active: boolean) =>
    `border-b-2 px-1 pb-2 text-sm font-medium ${
      active
        ? "border-zinc-900 text-zinc-900 dark:border-zinc-50 dark:text-zinc-50"
        : "border-transparent text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
    }`;

  return (
    <div className="mt-10">
      <div className="flex gap-6 border-b border-zinc-200 dark:border-zinc-800">
        <button type="button" className={tabButtonClass(tab === "trades")} onClick={() => setTab("trades")}>
          Trade log ({trades.length})
        </button>
        <button type="button" className={tabButtonClass(tab === "decisions")} onClick={() => setTab("decisions")}>
          Decision log ({decisionLog.length}
          {decisionLogTruncated ? "+" : ""})
        </button>
      </div>

      {tab === "trades" &&
        (trades.length === 0 ? (
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
                {trades.map((trade) => (
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
                      {formatTimestamp(trade.exitTime)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === "decisions" &&
        (decisionLog.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No decision log entries yet.</p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3">Event</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">Detail</th>
                    <th className="px-4 py-3">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {decisionLog.map((entry) => (
                    <tr key={entry.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                      <td className="px-4 py-3">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${
                            EVENT_BADGE_CLASS[entry.eventType] ??
                            "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          }`}
                        >
                          {entry.eventType}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">{entry.source}</td>
                      <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300">
                        {formatPayload(entry.payload)}
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                        {formatTimestamp(entry.timestamp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {decisionLogTruncated && (
              <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
                Showing the {decisionLog.length} most recent events only.
              </p>
            )}
          </>
        ))}
    </div>
  );
}
