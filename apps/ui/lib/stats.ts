import { Decimal } from "decimal.js";
import type { Decimal128 } from "mongodb";
import { toDecimalJs, type Trade } from "@trade-bot/shared";

export interface StrategyStats {
  totalTrades: number;
  winRate: number; // 0-100
  profitFactor: number | null; // null if there are no losing trades to divide by
  maxDrawdownPct: number; // relative to allocated capital
  sharpeLike: number | null; // null with fewer than 2 trades (stdev undefined)
  totalPnl: string;
  totalFeesPaid: string;
}

const EMPTY_STATS: StrategyStats = {
  totalTrades: 0,
  winRate: 0,
  profitFactor: null,
  maxDrawdownPct: 0,
  sharpeLike: null,
  totalPnl: "0",
  totalFeesPaid: "0",
};

// sharpeLike is mean(pnlPct) / stdev(pnlPct) across closed trades — useful
// for comparing strategies against each other, but NOT a proper
// time-annualized Sharpe ratio (that needs a consistent return-period
// assumption we don't have, since trade durations vary). Don't present
// this as "the Sharpe ratio" without that caveat.
//
// allocatedCapital anchors the equity curve's starting point and the
// drawdown-percentage denominator. An earlier version started the curve at
// 0 and measured drawdown against the curve's own peak — that blows up to
// nonsensical numbers (seen live: "2099.9%") the moment the peak is a tiny
// positive value early on, since any later loss is then huge *relative to
// that peak* even though it's small relative to actual capital.
export function computeStrategyStats(trades: Trade[], allocatedCapital: Decimal128): StrategyStats {
  if (trades.length === 0) {
    return EMPTY_STATS;
  }

  const ordered = [...trades].sort((a, b) => a.exitTime.getTime() - b.exitTime.getTime());

  const capital = toDecimalJs(allocatedCapital);
  let wins = 0;
  let grossProfit = new Decimal(0);
  let grossLoss = new Decimal(0);
  let totalPnl = new Decimal(0);
  let totalFees = new Decimal(0);
  let equity = capital;
  let peak = capital;
  let maxDrawdownPct = 0;

  for (const trade of ordered) {
    const pnl = toDecimalJs(trade.pnl);
    totalPnl = totalPnl.plus(pnl);
    totalFees = totalFees.plus(toDecimalJs(trade.feesPaid));

    if (pnl.greaterThan(0)) {
      wins += 1;
      grossProfit = grossProfit.plus(pnl);
    } else {
      grossLoss = grossLoss.plus(pnl.abs());
    }

    equity = equity.plus(pnl);
    if (equity.greaterThan(peak)) {
      peak = equity;
    }
    if (peak.greaterThan(0)) {
      const drawdownPct = peak.minus(equity).div(peak).mul(100).toNumber();
      if (drawdownPct > maxDrawdownPct) {
        maxDrawdownPct = drawdownPct;
      }
    }
  }

  const pnlPcts = ordered.map((trade) => trade.pnlPct);
  const mean = pnlPcts.reduce((sum, value) => sum + value, 0) / pnlPcts.length;
  const variance =
    pnlPcts.length > 1
      ? pnlPcts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (pnlPcts.length - 1)
      : 0;
  const stdev = Math.sqrt(variance);

  return {
    totalTrades: ordered.length,
    winRate: (wins / ordered.length) * 100,
    profitFactor: grossLoss.greaterThan(0) ? grossProfit.div(grossLoss).toNumber() : null,
    maxDrawdownPct,
    sharpeLike: pnlPcts.length > 1 && stdev > 0 ? mean / stdev : null,
    totalPnl: totalPnl.toString(),
    totalFeesPaid: totalFees.toString(),
  };
}
