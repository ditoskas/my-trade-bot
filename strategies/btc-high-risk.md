# BTC High-Risk

**Status:** draft, skeleton only — no entry, stop, or take-profit logic
defined yet. Created to start over from scratch after `short-term-high-risk`
tested negative on PENGUUSDT.P and ETHUSDT.P (multi-symbol edge unproven).
This strategy is deliberately scoped to **BTCUSDT.P only** — no symbol
scanner, no cross-symbol ambition. Rules will be filled in incrementally as
they're specified, not guessed at up front.

## Overview

Single-symbol, high-risk BTC perpetual futures strategy at **100x leverage**.
At 100x, liquidation sits roughly 1% away from entry (before fees, using the
simple `1/leverage` approximation — see `short-term-high-risk.md`'s Stop
loss logic for why this ignores Binance's real tiered maintenance-margin
brackets and is therefore optimistic, not conservative). Whatever
entry/stop logic gets specified next has to survive that constraint — a
structural stop wider than roughly 1% of price is not survivable at this
leverage without a much smaller position, which hasn't been decided yet
either.

**Scope**: BTCUSDT.P (Binance USDT-M perpetual futures) only. Deliberately
narrower than `short-term-high-risk`'s gainers/losers/favorites scanner —
that ambition is set aside for this strategy, not carried over.

## Entry logic

**Not yet specified.** No long or short entry condition exists yet — do not
assume this mirrors `short-term-high-risk`'s breakout logic.

## Stop loss logic

**Not yet specified.**

## Take profit logic

**Not yet specified.**

## Exit rules

**Not yet specified.**

## Position sizing

- **Leverage: 100x**, fixed — the one parameter specified so far.
- Margin per trade, compounding vs. fixed sizing, and max concurrent
  positions are all **not yet specified**.

## Targets

- **Market/timeframe**: BTCUSDT.P only. Candle interval not yet specified.
- **Performance expectation**: none set yet.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Leverage | 100x | Fixed — see the Pine `margin_long`/`margin_short` note below, that literal must be hand-edited if this changes. |

## Pine Script v6

Skeleton only — compiles and can be added to the chart, but has no entry
conditions, so it will show zero trades until entry/stop/TP logic is added.

```pinescript
//@version=6
strategy(
     "BTC High-Risk",
     overlay=true,
     default_qty_type=strategy.fixed,
     default_qty_value=0,
     initial_capital=1000,
     currency=currency.USDT,
     // Simulates 100x leverage (100/100 = 1). This is a COMPILE-TIME
     // CONSTANT — Pine does not allow margin_long/margin_short to reference
     // an input variable, so this literal must be hand-edited if leverage
     // ever changes, independent of the "leverage" input below.
     margin_long = 1,
     margin_short = 1,
     commission_type = strategy.commission.percent,
     commission_value = 0.05)

// ---- Inputs ----
leverage = input.float(100, "Leverage (see margin_long/short note above)", minval = 1, maxval = 125, step = 1)

// ---- Entry logic: not yet specified ----
// No strategy.entry() calls yet.

// ---- Stop loss / take profit logic: not yet specified ----
// No strategy.exit() calls yet.

// Placeholder so the script has at least one plot and compiles cleanly
// while entry/exit logic is still being defined.
plot(close, "Close", color = color.gray)
```

## Backtest notes

- Nothing to backtest yet — the script above produces zero trades by design.
- Once entry logic exists, re-check the 100x liquidation-distance math (see
  Overview) against whatever stop distance gets specified — this is the
  first thing likely to make or break the strategy at this leverage.

## Next steps

1. Specify entry logic (long/short conditions, timeframe).
2. Specify stop loss logic — given 100x leverage, this is the most
   consequential decision, not a formality.
3. Specify take profit logic and exit rules.
4. Specify position sizing (margin per trade, compounding, max concurrent
   positions).
5. Specify targets/performance expectations, if any.
