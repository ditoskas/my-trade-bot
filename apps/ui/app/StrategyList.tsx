"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { StrategySummary } from "@/lib/types";

interface LiveState {
  lifecycleState?: string;
  killSwitchEngaged?: boolean;
  lastEventType?: string;
  lastEventAt?: string;
}

interface StrategyEventMessage {
  type: string;
  strategySlug: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

const STATE_STYLES: Record<string, string> = {
  paper: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  live_small: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  live_full: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  retired: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  draft: "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500",
  backtested: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
};

function StateBadge({ state }: { state: string }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_STYLES[state] ?? STATE_STYLES.draft}`}>
      {state}
    </span>
  );
}

export function StrategyList({ initialStrategies }: { initialStrategies: StrategySummary[] }) {
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      let message: StrategyEventMessage;
      try {
        message = JSON.parse(event.data as string) as StrategyEventMessage;
      } catch {
        return;
      }
      setLive((prev) => {
        const previousEntry = prev[message.strategySlug];
        const nextLifecycleState =
          typeof message.payload.lifecycleState === "string"
            ? message.payload.lifecycleState
            : previousEntry?.lifecycleState;
        const nextKillSwitchEngaged =
          typeof message.payload.killSwitchEngaged === "boolean"
            ? message.payload.killSwitchEngaged
            : previousEntry?.killSwitchEngaged;
        return {
          ...prev,
          [message.strategySlug]: {
            lifecycleState: nextLifecycleState,
            killSwitchEngaged: nextKillSwitchEngaged,
            lastEventType: message.type,
            lastEventAt: message.timestamp,
          },
        };
      });
    };
    return () => source.close();
  }, []);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-400"}`} />
        {connected ? "live" : "connecting…"}
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3">Strategy</th>
              <th className="px-4 py-3">Symbols</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3">Kill switch</th>
              <th className="px-4 py-3">Leverage</th>
              <th className="px-4 py-3">Last event</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {initialStrategies.map((strategy) => {
              const overlay = live[strategy.slug];
              const lifecycleState = overlay?.lifecycleState ?? strategy.lifecycleState;
              const killSwitchEngaged = overlay?.killSwitchEngaged ?? strategy.killSwitchEngaged;
              return (
                <tr key={strategy.slug} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/strategies/${strategy.slug}`}
                      className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
                    >
                      {strategy.name}
                    </Link>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">{strategy.broker}</div>
                  </td>
                  <td className="px-4 py-3">{strategy.symbols.join(", ")}</td>
                  <td className="px-4 py-3">
                    <StateBadge state={lifecycleState} />
                  </td>
                  <td className="px-4 py-3">
                    {killSwitchEngaged ? (
                      <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
                        engaged
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400">off</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{strategy.maxLeverage}x</td>
                  <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                    {overlay?.lastEventType && overlay.lastEventAt
                      ? `${overlay.lastEventType} · ${new Date(overlay.lastEventAt).toLocaleTimeString()}`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
