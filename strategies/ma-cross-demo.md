# MA Cross Demo

**Status:** promoted — this documents the strategy already running in
`apps/engine` (`strategy/movingAverageCross.ts`, seeded by `index.ts` as
`ma-cross-demo` on BTCUSDT and `ma-cross-demo-eth` on ETHUSDT). Written after
the fact to establish the documentation format, not as a new prototype —
see the honest gaps called out below rather than a cleaned-up version of
reality.

## Overview

A trivial fast/slow SMA crossover, long or short, no fixed stop loss or take
profit. It exists in the engine to exercise the trading pipeline end to end
(decision → risk check → capital reservation → broker order → Mongo), not
because it's a good strategy. Treat the Pine backtest below as a way to see
its real historical behavior, not a reason to trust it with meaningful size.

## Entry logic

- **Long**: fast SMA crosses above slow SMA, and the strategy isn't already
  long.
- **Short**: fast SMA crosses below slow SMA, and the strategy isn't already
  short.
- A cross while holding the *opposite* side is a flip: the engine closes the
  existing position and opens the new one on the same signal, rather than
  requiring two separate signals. See `strategyRunner.ts`'s comment on why —
  an earlier version that used separate exit signals for a reversal made one
  direction structurally unreachable, since crosses always alternate.

## Stop loss logic

**None.** The strategy has no stop loss of any kind — the only way out of a
losing position is an opposing cross. This is a real, known gap: a strong
one-directional move against an open position has no protection until the
indicator reverses, which can be arbitrarily late. Don't read the absence of
this section's content as an oversight in the documentation; it's an
accurate description of the current code.

## Take profit logic

**None**, for the same reason — exits are signal-only.

## Exit rules

- Exit (or flip) exclusively on the opposing SMA cross. No time-based exit,
  no trailing stop, no volatility-based exit.

## Position sizing

- Deploys the strategy's *entire* free capital as margin on every entry, at
  a fixed 3x leverage (`riskLimits.maxLeverage`) — notional exposure =
  margin × leverage. See `CLAUDE.md` Phase 3b for why leverage is
  per-strategy configurable rather than a single global setting.
- No partial sizing, no scaling in/out.

## Targets

- **Market/timeframe**: BTCUSDT and ETHUSDT, 1-minute candles (live), backtest
  below uses the same interval.
- **Performance expectations**: none, deliberately — this strategy is a
  pipeline proof, not a return-seeking one. Don't use its backtest P&L as a
  reason to increase its allocated capital or leverage.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Fast SMA period | 5 | `config.fastPeriod` in the strategy doc |
| Slow SMA period | 20 | `config.slowPeriod` |
| Leverage | 3x | `riskLimits.maxLeverage` |
| Allocated capital | 1000 USDT | `allocatedCapital` |

## Pine Script v6

Mirrors the engine's actual behavior as closely as Pine allows:
`process_orders_on_close=true` so decisions happen at candle close (matching
the engine only acting on *closed* candles from Binance's kline stream), and
`margin_long`/`margin_short` set to `100 / leverage` to simulate 3x leverage —
Pine v6 defaults both to 100 (no leverage) unless set explicitly. Commission
is set to 0.1% to match `PaperBroker`'s fee assumption.

```pinescript
//@version=6
strategy(
     "MA Cross Demo (5/20, 3x)",
     overlay=true,
     default_qty_type=strategy.percent_of_equity,
     default_qty_value=100,
     margin_long=33.33,
     margin_short=33.33,
     commission_type=strategy.commission.percent,
     commission_value=0.1,
     process_orders_on_close=true)

fastPeriod = input.int(5, "Fast SMA period", minval=1)
slowPeriod = input.int(20, "Slow SMA period", minval=1)

fastMA = ta.sma(close, fastPeriod)
slowMA = ta.sma(close, slowPeriod)

longCondition  = ta.crossover(fastMA, slowMA)
shortCondition = ta.crossunder(fastMA, slowMA)

// No strategy.exit() calls — deliberately. Calling strategy.entry() for the
// opposite direction while a position is open closes it and opens the new
// one automatically, which is the same flip semantics the real engine uses.
if longCondition
    strategy.entry("Long", strategy.long)

if shortCondition
    strategy.entry("Short", strategy.short)

plot(fastMA, "Fast SMA", color = color.blue)
plot(slowMA, "Slow SMA", color = color.orange)
```

## Backtest notes

- Paste into TradingView's Pine Editor on a BTCUSDT or ETHUSDT chart, 1-minute
  timeframe, then open the Strategy Tester tab.
- Because there's no stop loss, a single adverse trend can produce a large
  single-trade loss in the backtest — that's expected given the logic above,
  not a bug in the Pine code.
- TradingView's Strategy Tester and the live engine will not produce
  identical trade-for-trade results even on the same symbol/interval: fill
  price assumptions, historical data source, and exact candle-close timing
  differ. Use this for directional insight (does the logic even work?), not
  as a precise prediction of live behavior.

## Next steps

If this strategy is ever meant to hold real capital rather than just prove
the pipeline, it needs a stop loss at minimum — see `update-strategy` to add
one once a rule is decided on.
