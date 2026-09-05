import type { ObjectId } from "mongodb";

export type ChatopsCommandType = "PAUSE" | "RESUME" | "KILL" | "STATUS" | "REPORT";
export type ChatopsCommandStatus = "PENDING" | "APPLIED" | "REJECTED";

// Written by the chatops Telegram bot (Phase 5), applied by the Engine via
// its internal API — chatops never touches Binance or Mongo trade data
// directly, see CLAUDE.md "Non-negotiable policies".
export interface ChatopsCommand {
  _id: ObjectId;
  commandType: ChatopsCommandType;
  targetStrategyId: ObjectId | null;
  issuedBy: string;
  status: ChatopsCommandStatus;
  result?: string;
  createdAt: Date;
  appliedAt?: Date;
}
