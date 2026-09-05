import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import {
  computeStrategyStats,
  strategiesCollection,
  tradesCollection,
  type ControlApiClient,
} from "@trade-bot/shared";
import type { Db } from "mongodb";

const HELP_TEXT = [
  "Commands:",
  "/status — list strategies and their state",
  "/pause <slug>",
  "/resume <slug>",
  "/kill <slug> — engage the kill switch (blocks new entries)",
  "/unkill <slug>",
  "/report <slug> — stats and PnL for one strategy",
].join("\n");

function parseSlugArg(ctx: Context): string | null {
  if (!ctx.has(message("text"))) {
    return null;
  }
  const parts = ctx.message.text.trim().split(/\s+/);
  return parts[1] ?? null;
}

// Fixed command set only — no LLM/MCP here (see CLAUDE.md Phase 5). The
// natural-language layer, when it's built, sits on top of these same
// ControlApiClient calls with its own allow-list and confirmation step;
// it never gets a wider surface than what's already exposed here.
export function createBot(token: string, allowedChatIds: Set<number>, controlApi: ControlApiClient, db: Db): Telegraf {
  const bot = new Telegraf(token);

  // Every other handler runs only for allow-listed chats. Unauthorized
  // messages are silently ignored — not even an error reply — so a
  // stranger who finds the bot token learns nothing about what it does.
  bot.use((ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !allowedChatIds.has(chatId)) {
      console.warn(`[chatops] ignored message from unauthorized chat ${chatId ?? "unknown"}`);
      return;
    }
    return next();
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP_TEXT));

  bot.command("status", async (ctx) => {
    try {
      const strategies = await controlApi.getStatus();
      if (strategies.length === 0) {
        await ctx.reply("No strategies are currently running in the engine.");
        return;
      }
      const lines = strategies.map(
        (strategy) =>
          `${strategy.slug} — ${strategy.lifecycleState}` +
          `${strategy.killSwitchEngaged ? " · KILL SWITCH ENGAGED" : ""} (${strategy.symbols.join(", ")})`,
      );
      await ctx.reply(lines.join("\n"));
    } catch (error) {
      await ctx.reply(`Couldn't reach the engine: ${(error as Error).message}`);
    }
  });

  const controlCommand = (action: "pause" | "resume" | "kill" | "unkill") => async (ctx: Context) => {
    const slug = parseSlugArg(ctx);
    if (!slug) {
      await ctx.reply(`Usage: /${action} <strategy-slug>`);
      return;
    }
    try {
      const ok = await controlApi.runAction(slug, action);
      await ctx.reply(
        ok ? `${action} applied to "${slug}".` : `"${slug}" isn't running in the engine right now.`,
      );
    } catch (error) {
      await ctx.reply(`Couldn't reach the engine: ${(error as Error).message}`);
    }
  };

  bot.command("pause", controlCommand("pause"));
  bot.command("resume", controlCommand("resume"));
  bot.command("kill", controlCommand("kill"));
  bot.command("unkill", controlCommand("unkill"));

  bot.command("report", async (ctx) => {
    const slug = parseSlugArg(ctx);
    if (!slug) {
      await ctx.reply("Usage: /report <strategy-slug>");
      return;
    }

    const strategy = await strategiesCollection(db).findOne({ slug });
    if (!strategy) {
      await ctx.reply(`No strategy named "${slug}".`);
      return;
    }

    const trades = await tradesCollection(db).find({ strategyId: strategy._id }).toArray();
    const stats = computeStrategyStats(trades, strategy.allocatedCapital);

    await ctx.reply(
      [
        `${strategy.name} (${strategy.lifecycleState})`,
        `Trades: ${stats.totalTrades} · Win rate: ${stats.winRate.toFixed(1)}%`,
        `Profit factor: ${stats.profitFactor === null ? "—" : stats.profitFactor.toFixed(2)}`,
        `Max drawdown: ${stats.maxDrawdownPct.toFixed(1)}% of allocated capital`,
        `Total PnL: ${stats.totalPnl} ${strategy.allocatedCapitalAsset} (fees: ${stats.totalFeesPaid})`,
      ].join("\n"),
    );
  });

  return bot;
}
