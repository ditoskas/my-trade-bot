import { closeMongo, connectMongo, ControlApiClient } from "@trade-bot/shared";
import { startAlertWatcher } from "./alerts";
import { createBot } from "./bot";

// Phase 5: fixed Telegram command set only, calling the Engine's internal
// control API — no LLM/MCP in this path (see CLAUDE.md's non-negotiable
// policies). Long-polling, not a webhook — simplest option for a bot that
// doesn't need a public HTTPS endpoint.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number),
);
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/trade-bot-dev";
const ENGINE_CONTROL_API_URL = process.env.ENGINE_CONTROL_API_URL ?? "http://127.0.0.1:4001";
const ENGINE_CONTROL_API_TOKEN = process.env.ENGINE_CONTROL_API_TOKEN ?? "dev-only-insecure-token";

if (!BOT_TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN (create one via @BotFather on Telegram) before running chatops.");
  process.exit(1);
}
if (ALLOWED_CHAT_IDS.size === 0) {
  console.error(
    "Set TELEGRAM_ALLOWED_CHAT_IDS (comma-separated chat/user IDs) — refusing to run an unrestricted bot. " +
      "Message the bot once and check the [chatops] ignored-message log line for your chat ID, or ask @userinfobot.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const connection = await connectMongo(MONGODB_URI);
  const controlApi = new ControlApiClient({ baseUrl: ENGINE_CONTROL_API_URL, token: ENGINE_CONTROL_API_TOKEN });
  const bot = createBot(BOT_TOKEN!, ALLOWED_CHAT_IDS, controlApi, connection.db);
  const stopAlertWatcher = startAlertWatcher(bot, connection.db, ALLOWED_CHAT_IDS);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[chatops] shutting down (${signal})...`);
    stopAlertWatcher();
    bot.stop(signal);
    await closeMongo(connection);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // bot.launch()'s returned promise resolves only when the bot *stops*
  // (it's the long-polling loop itself, not a one-time connect step) — do
  // not await it here, or "running" would only ever log after shutdown.
  // The onLaunch callback fires once connected instead.
  bot.launch(() => {
    console.log(`[chatops] running, ${ALLOWED_CHAT_IDS.size} authorized chat(s) — press Ctrl+C to stop`);
  }).catch((error: unknown) => {
    console.error("[chatops] fatal error:", error);
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  console.error("[chatops] fatal error:", error);
  process.exitCode = 1;
});
