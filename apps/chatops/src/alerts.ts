import { auditLogCollection, type AuditEventType } from "@trade-bot/shared";
import type { Db } from "mongodb";
import type { Telegraf } from "telegraf";

const ALERT_EVENT_TYPES: AuditEventType[] = ["RECONCILIATION_MISMATCH", "KILL_SWITCH", "STRATEGY_START_FAILED"];
const POLL_INTERVAL_MS = 30_000;

// Proactive alerting (Phase 6) — chatops is the only service holding
// Telegram credentials, so it's the natural place for this rather than
// having the engine reach out to Telegram directly. Polls audit_log for
// events worth surfacing without the operator having to ask, and pushes
// them to every allow-listed chat. Returns a function to stop polling.
export function startAlertWatcher(bot: Telegraf, db: Db, allowedChatIds: Set<number>): () => void {
  let since = new Date();

  const timer = setInterval(() => {
    void (async () => {
      const entries = await auditLogCollection(db)
        .find({ eventType: { $in: ALERT_EVENT_TYPES }, timestamp: { $gt: since } })
        .sort({ timestamp: 1 })
        .toArray();
      if (entries.length === 0) {
        return;
      }
      since = entries[entries.length - 1]!.timestamp;

      for (const entry of entries) {
        const strategyNote = entry.strategyId ? ` (strategy ${entry.strategyId.toHexString()})` : "";
        const text = `${entry.eventType}${strategyNote}\n${JSON.stringify(entry.payload)}`;
        for (const chatId of allowedChatIds) {
          await bot.telegram
            .sendMessage(chatId, text)
            .catch((error: unknown) => console.error(`[chatops] failed to send alert to ${chatId}:`, error));
        }
      }
    })().catch((error: unknown) => console.error("[chatops] alert watcher error:", error));
  }, POLL_INTERVAL_MS);

  return () => clearInterval(timer);
}
