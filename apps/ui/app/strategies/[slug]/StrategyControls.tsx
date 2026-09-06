"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface StrategyEventMessage {
  type: string;
  strategySlug: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

interface Props {
  slug: string;
  initialLifecycleState: string;
  initialKillSwitchEngaged: boolean;
  initialEnabled: boolean;
}

const ARM_TIMEOUT_MS = 4000;

// Kill switch + pause/resume + enable/disable, and a live trade-log
// refresh: rather than duplicating trade/stats computation on the client,
// this just calls router.refresh() whenever an ORDER_FILLED event for
// this strategy arrives over SSE — the server component re-fetches from
// Mongo and the page updates with the new trade already computed into
// the stats.
//
// enabled is distinct from lifecycleState/killSwitchEngaged: a disabled
// strategy has no runner in the engine at all (see
// packages/shared/src/models/strategy.ts's `enabled` field comment), so
// pause/resume/kill/unkill would just fail against it — only Enable makes
// sense until it's running.
//
// The kill switch uses an arm-then-confirm click pattern rather than
// window.confirm() — a native dialog blocks the page's own event loop
// (including this component's SSE listener) for as long as it's open,
// which is the wrong trade-off for a live trading control. Enable/Disable
// don't need that same treatment: enabling just starts monitoring
// (matches Resume's risk level), and disabling is already refused
// server-side whenever a real position is open, so there's no
// "accidentally abandon a position" click to guard against here.
export function StrategyControls({ slug, initialLifecycleState, initialKillSwitchEngaged, initialEnabled }: Props) {
  const router = useRouter();
  const [lifecycleState, setLifecycleState] = useState(initialLifecycleState);
  const [killSwitchEngaged, setKillSwitchEngaged] = useState(initialKillSwitchEngaged);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (event) => {
      let message: StrategyEventMessage;
      try {
        message = JSON.parse(event.data as string) as StrategyEventMessage;
      } catch {
        return;
      }
      if (message.strategySlug !== slug) {
        return;
      }
      if (typeof message.payload.lifecycleState === "string") {
        setLifecycleState(message.payload.lifecycleState);
      }
      if (typeof message.payload.killSwitchEngaged === "boolean") {
        setKillSwitchEngaged(message.payload.killSwitchEngaged);
      }
      if (typeof message.payload.enabled === "boolean") {
        setEnabled(message.payload.enabled);
      }
      if (message.type === "ORDER_FILLED") {
        router.refresh();
      }
    };
    return () => source.close();
    // Next.js's router object is stable across renders — safe to omit
    // from deps without re-subscribing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function callAction(action: "pause" | "resume" | "kill" | "unkill" | "enable" | "disable"): Promise<void> {
    setPending(action);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/strategies/${slug}/${action}`, { method: "POST" });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!body.ok) {
        setErrorMessage(`"${action}" failed: ${body.error ?? "strategy not running in the engine right now"}`);
        return;
      }
      if (action === "pause") setLifecycleState("paused");
      if (action === "resume") setLifecycleState("paper");
      if (action === "kill") setKillSwitchEngaged(true);
      if (action === "unkill") setKillSwitchEngaged(false);
      if (action === "enable") setEnabled(true);
      if (action === "disable") setEnabled(false);
    } catch (error) {
      setErrorMessage(`Couldn't reach the control API: ${(error as Error).message}`);
    } finally {
      setPending(null);
    }
  }

  const buttonClass =
    "rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

  if (!enabled) {
    return (
      <div className="flex shrink-0 flex-col items-end gap-2">
        <div className="text-xs text-zinc-400 dark:text-zinc-500">off — not running in the engine</div>
        {errorMessage && <div className="max-w-xs text-right text-xs text-red-500">{errorMessage}</div>}
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void callAction("enable")}
          className={`${buttonClass} border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950`}
        >
          {pending === "enable" ? "Enabling…" : "Enable"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <div className="text-xs text-zinc-400 dark:text-zinc-500">
        {lifecycleState} {killSwitchEngaged && "· kill switch engaged"}
      </div>
      {errorMessage && <div className="max-w-xs text-right text-xs text-red-500">{errorMessage}</div>}
      <div className="flex gap-2">
        {lifecycleState === "paused" ? (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void callAction("resume")}
            className={`${buttonClass} border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950`}
          >
            {pending === "resume" ? "Resuming…" : "Resume"}
          </button>
        ) : (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void callAction("pause")}
            className={`${buttonClass} border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950`}
          >
            {pending === "pause" ? "Pausing…" : "Pause"}
          </button>
        )}
        {killSwitchEngaged ? (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void callAction("unkill")}
            className={`${buttonClass} border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
          >
            {pending === "unkill" ? "Re-enabling…" : "Disengage kill switch"}
          </button>
        ) : (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => {
              if (armed) {
                setArmed(false);
                void callAction("kill");
              } else {
                setArmed(true);
              }
            }}
            className={`${buttonClass} ${
              armed
                ? "border-red-600 bg-red-600 text-white hover:bg-red-700"
                : "border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            }`}
          >
            {pending === "kill" ? "Engaging…" : armed ? "Click again to confirm" : "Kill switch"}
          </button>
        )}
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void callAction("disable")}
          className={`${buttonClass} border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
        >
          {pending === "disable" ? "Disabling…" : "Disable"}
        </button>
      </div>
    </div>
  );
}
