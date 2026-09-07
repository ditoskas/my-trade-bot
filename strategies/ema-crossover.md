# EMA Crossover

**Status:** draft — the original 20x/30%-margin, no-filter version lost
94% of equity, and a 5x/10%-margin/100-EMA-filter version cut that to a
~16% loss but barely reduced whipsaw trades (see "Backtest results
(pre-fix)" and "(post-fix, 100-EMA)" below). The trend filter length has
since been dropped to 50 to react faster to chop — **not yet re-tested**.
Don't treat the current version as validated until it's been run again.

## Overview

Single-symbol DOGEUSDT.P, **20x leverage**, 1h candles. Core thesis: price
tends to keep moving in the direction of a recently-established trend, so a
fast EMA crossing a slow EMA is used as the trend-flip signal. Built as a
deliberately higher-frequency alternative to
[`momentum-play-liquidation.md`](momentum-play-liquidation.md), whose
≥3×ATR wick condition turned out to be too rare an event to produce more
than a handful of trades across 8+ months of history — a crossover fires
whenever the trend direction actually flips, which happens far more often
than a liquidation-cascade wick, so this is expected to trade closer to the
user's stated target of roughly 1 trade per day to 1 trade every 2 days. 1h
was chosen over 4h specifically for that frequency reason — a 4h crossover
on this pair would likely fire less than once a day, undershooting the
target.

## Entry logic

Bidirectional, on the 1h candle close:

- **Long**: fast EMA crosses above slow EMA (`ta.crossover(fastEMA,
  slowEMA)`) **and** price is above the longer-term trend EMA (`close >
  trendEMA`).
- **Short**: fast EMA crosses below slow EMA (`ta.crossunder(fastEMA,
  slowEMA)`) **and** price is below the trend EMA (`close < trendEMA`).

**Added after the pre-fix backtest** (see Backtest results below): the
original version had no regime filter at all and whipsawed heavily during
DOGE's extended sideways stretches, reversing on nearly every crossover
even with no real trend behind it. A trend EMA filter rejects crossover
signals that go against the larger trend, on the theory that most of the
damage came from taking *both* sides of a crossover pair inside a range
rather than from any single bad signal.

**Trend EMA length dropped from 100 to 50** after the post-fix backtest
(see "Backtest results (post-fix, 100-EMA)" below): a 100-period filter
barely changed trade count versus no filter at all (~150 → ~160), meaning
it was too slow to reject much of anything — a 50-period trend EMA reacts
faster to the same chop and should actually filter more of the
whipsaw-prone signals, at the cost of also reducing trade frequency more
than the 100-period version did.

## Stop loss logic

**80% of the margin allocated to the trade**, expressed as a price stop.
At the fixed 20x leverage, an 80%-of-margin loss corresponds to a **4%
adverse price move** (80% ÷ 20x) from entry — this is what the Pine script
actually places as `stop=`. Framed as a margin-loss percentage rather than
a plain price percentage or ATR multiple, per explicit request — it scales
automatically with whatever the configured leverage is, rather than
needing to be recalculated by hand if leverage changes.

## Take profit logic

**Activation-triggered trailing stop, not a fixed target.** Once the
trade's unrealized profit reaches **100% of allocated margin** (a 5%
favorable price move at 20x leverage), a trailing stop activates and
trails **20% of margin** (a 1% price pullback) behind the best price
reached since activation. This guarantees locking in at least ~80% margin
profit once triggered — deliberately symmetric with the 80%-margin stop
loss on the downside — while still letting the position ride further if
the trend keeps extending. Implemented via Pine's native
`trail_price`/`trail_offset` on `strategy.exit()`, not a hand-rolled
bar-by-bar trail.

## Exit rules

A position closes on whichever of these fires first:
1. The 4%-price stop loss (80% margin loss), or
2. The trailing stop after the 100%-margin-profit activation point, or
3. **An opposite-direction EMA crossover** — this closes (and immediately
   reverses into) the position regardless of where price sits relative to
   the stop/trail above. Only one position open at a time, same convention
   as every other strategy in this project — a reversal signal doesn't
   stack a second position on top of the first.

## Position sizing

**Fixed % of equity used as margin per trade** — **10% of current equity**
as margin, at **5x leverage**, giving **50% notional exposure per trade**
(margin × leverage). Cut down from the original 30%/20x (600% notional)
specifically because that sizing was diagnosed as the multiplier that
turned ordinary whipsaw losses into a 94% account wipeout — see Backtest
results below. No partial sizing, no scaling in/out.

## Targets

- **Market regime**: none — explicitly meant to trade in all market
  conditions, not gated to trending/ranging/high-volatility regimes.
- **Performance expectation**: the user's stated target is **at least 30%
  daily profit relative to the previous day**. Recording this as stated,
  but flagging it plainly: sustained 30%/day compounding is an extremely
  aggressive target (it implies roughly 1,300,000% annualized if actually
  sustained) — this should be treated as aspirational, not as a number the
  Pine backtest below is expected to validate. Judge the strategy on its
  real win rate/PF/drawdown once backtested, not against this target.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Symbol | DOGEUSDT.P | |
| Candle interval | 1h | chosen for trade-frequency target, not tested against alternatives yet |
| Fast EMA length | 9 | starting default, not calibrated — see Next steps |
| Slow EMA length | 21 | starting default, not calibrated — see Next steps |
| Trend filter EMA length | 50 | dropped from 100 after the post-fix backtest barely changed trade count — see Entry logic |
| Leverage | 5x | cut from 20x after the pre-fix backtest — see Backtest results |
| Margin % of equity per trade | 10% | cut from 30% after the pre-fix backtest |
| Stop loss | 80% of margin | = 16% price move at 5x |
| Trailing-stop activation | 100% of margin | = 20% price move at 5x |
| Trailing-stop offset | 20% of margin | = 4% price move at 5x |

## Pine Script v6

Runs on the **1h chart**. Single-symbol, single-timeframe — no
`request.security()` needed. Entries evaluated on bar close
(`process_orders_on_close=true`). The stop/trail-activation/trail-offset
percentages are all margin-based per the interview, so they're converted
to price distances using the fixed leverage input before being handed to
`strategy.exit()` — `trail_offset` specifically must be expressed in ticks
(price increments), not raw price, hence the division by
`syminfo.mintick`.

```pinescript
//@version=6
strategy(
     "EMA Crossover",
     overlay=true,
     default_qty_type=strategy.fixed,
     default_qty_value=0,
     initial_capital=1000,
     currency=currency.USDT,
     // Simulates 5x leverage (100/5). COMPILE-TIME CONSTANT — Pine does
     // not allow margin_long/margin_short to reference an input variable,
     // so this literal must be hand-edited if the leverage input's default
     // is ever changed.
     margin_long = 20.0,
     margin_short = 20.0,
     commission_type = strategy.commission.percent,
     commission_value = 0.1,
     process_orders_on_close = true)

// ---- Inputs ----
fastLen                = input.int(9, "Fast EMA length")
slowLen                = input.int(21, "Slow EMA length")
trendLen               = input.int(50, "Trend filter EMA length")
leverage               = input.float(5, "Leverage (see margin_long/short note above)", minval = 1, maxval = 20, step = 1)
marginPct              = input.float(10, "Margin % of equity per trade")
stopMarginPct          = input.float(80, "Stop-loss: % of margin lost")
trailActivateMarginPct = input.float(100, "Trailing-stop activation: % of margin gained")
trailOffsetMarginPct   = input.float(20, "Trailing-stop offset: % of margin given back")

fastEMA  = ta.ema(close, fastLen)
slowEMA  = ta.ema(close, slowLen)
trendEMA = ta.ema(close, trendLen)

// Trend filter added post-mortem: only take a crossover in the direction
// of the larger trend, to cut the whipsaw-in-chop losses that drove the
// pre-fix 94% drawdown (see Backtest results below).
longSignal  = ta.crossover(fastEMA, slowEMA) and close > trendEMA
shortSignal = ta.crossunder(fastEMA, slowEMA) and close < trendEMA

// ---- Position sizing: fixed % of equity as margin ----
f_qty(entryClose) =>
    margin = strategy.equity * marginPct / 100
    (margin * leverage) / entryClose

// Margin-loss/gain percentages -> price-move percentages, using the fixed
// leverage above (margin % / leverage = price %).
stopDistPct          = stopMarginPct / 100 / leverage
trailActivateDistPct = trailActivateMarginPct / 100 / leverage
trailOffsetDistPct   = trailOffsetMarginPct / 100 / leverage

// ---- Entries — bidirectional; an opposite signal reverses automatically
// since strategy.entry() for the other side closes the existing position
// first, same flip semantics as ma-cross-demo.md ----
if longSignal
    entryPrice         = close
    stopPrice          = entryPrice * (1 - stopDistPct)
    trailActivatePrice = entryPrice * (1 + trailActivateDistPct)
    trailOffsetTicks   = (entryPrice * trailOffsetDistPct) / syminfo.mintick
    strategy.entry("Long", strategy.long, qty = f_qty(entryPrice))
    strategy.exit("Bracket-L", from_entry = "Long", stop = stopPrice, trail_price = trailActivatePrice, trail_offset = trailOffsetTicks)

if shortSignal
    entryPrice         = close
    stopPrice          = entryPrice * (1 + stopDistPct)
    trailActivatePrice = entryPrice * (1 - trailActivateDistPct)
    trailOffsetTicks   = (entryPrice * trailOffsetDistPct) / syminfo.mintick
    strategy.entry("Short", strategy.short, qty = f_qty(entryPrice))
    strategy.exit("Bracket-S", from_entry = "Short", stop = stopPrice, trail_price = trailActivatePrice, trail_offset = trailOffsetTicks)

plot(fastEMA, "Fast EMA", color = color.teal)
plot(slowEMA, "Slow EMA", color = color.orange)
plot(trendEMA, "Trend EMA", color = color.gray)
```

## Backtest notes

- Paste into TradingView's Pine Editor on a **DOGEUSDT.P, 1-hour** chart,
  then open the Strategy Tester tab.
- The trailing-stop mechanism relies on Pine's native `trail_price`/
  `trail_offset`, which is a reasonable approximation of "activate at X,
  then trail by Y" but won't behave identically to a hand-managed
  bar-by-bar trail — worth checking the actual exit fills in the List of
  Trades once backtested, not just the summary stats.
- Watch for the same TradingView bar-count limit hit while testing
  `momentum-play-liquidation` (free/Basic plans cap around 5,000 historical
  bars) — on 1h candles that's roughly 208 days, which should be enough to
  find dozens of crossovers, unlike the 30m/5m liquidation-wick case.

## Backtest results (pre-fix — 20x leverage, 30% margin, no trend filter)

**Superseded by the changes above — recorded here as the diagnosis that
drove them, not as a result to expect from the current version.**

Run live on TradingView (DOGEUSDT.P, 1h, Jan 5 – Sep 7 2026) using a
diagnostic build with `log.info()` on every entry and every full flat-exit.
Traced from the downloaded log:

| Metric | Value |
|---|---|
| Starting equity | 1000 USDT |
| Ending equity | ~56 USDT |
| Total return | **-94.4%** |
| Entries | ~150 over ~8 months (close to the 1/day-to-1/2-days target) |

**Diagnosis**: trade frequency was actually fine — the problem was that the
9/21 crossover, with no regime filter, whipsawed heavily during DOGE's
extended sideways stretches, reversing on nearly every crossover regardless
of whether a real trend was behind it. The clearest example in the log: a
~5-week stretch (late April – early June 2026) where the position never
went fully flat, just kept reversing crossover after crossover, netting
**-962 equity** in that stretch alone. What turned that ordinary whipsaw
bleed into a 94% wipeout specifically was the leverage: 20x at 30% margin
(600% notional) meant every losing flip removed a large fraction of
equity, and re-sizing each new trade off the shrinking equity base
compounded the damage — a -20% hit needs +25% just to break even, a -50%
hit needs +100%.

This directly informed both changes above: the trend-EMA filter targets
the whipsaw itself (don't take crossovers against the larger trend), and
the leverage/margin cut targets the compounding multiplier (a losing flip
now costs roughly 12x less in notional terms than before).

## Backtest results (post-fix, 100-EMA trend filter — superseded below)

**Superseded by the 50-EMA change above** — recorded here as the result
that motivated dropping the trend filter length from 100 to 50, not as
what to expect from the current version.

Run live on TradingView (DOGEUSDT.P, 1h, same Jan 5 – Sep 7 2026 window as
the pre-fix run) using an updated diagnostic build. Traced from the
downloaded log:

| Metric | Value |
|---|---|
| Starting equity | 1000 USDT |
| Ending equity (last entry, position still open) | ~838 USDT |
| Total return | **~-16%** |
| Peak equity | ~1157 (Feb 12 2026) |
| Trough after peak | ~764 (Aug 19 2026) — **~34% drawdown from peak** |
| Entries | ~160 over ~8 months (still close to the 1/day-to-1/2-days target) |
| Full flat-exits (stop or trailing-stop actually hit) | **4** — almost every position change is a direct crossover reversal instead |

**Honest read**: this is a large improvement over the pre-fix 94% wipeout —
the leverage/margin cut clearly did its job, turning a catastrophic
compounding spiral into a survivable, mild drag. But it's still a **net
loss**, not a working edge. Only 4 of ~160 trades ever hit the stop or
trailing-stop; the rest are the crossover reversing directly, which means
the underlying whipsaw problem the trend filter was meant to reduce is
still happening — it's just no longer being amplified into ruin by
leverage. The trend filter changed the *survivability* of the strategy,
not (yet) its *profitability*.

## Next steps

1. **This still isn't a profitable strategy as configured** — don't move
   toward paper/live capital based on this result. The next real question
   is why so few trades (4/160) ever reach the stop/trail at all — either
   the 16%/20%/4% price-move distances (post-leverage-cut) are simply too
   wide to matter on DOGE's typical 1h range, or the crossover reverses
   faster than price can travel that far. Worth adding per-trade PnL
   logging on the *reversal* path specifically (not just full flat-exits)
   to see the real win/loss distribution — the current diagnostic script
   only captures pnl cleanly on full flat-exits.
2. **Calibrate the 9/21/100 EMA lengths together** — the trend filter
   reduced entries only slightly (~150 → ~160, actually about the same),
   suggesting it isn't rejecting much; a shorter trend EMA (e.g. 50) or a
   stricter filter (e.g. requiring the trend EMA itself to be sloping, not
   just price on one side of it) may be needed to actually cut whipsaw
   trades rather than just leverage exposure.
3. Given the ~34% drawdown from peak still happened with the filter in
   place, **chop risk is reduced, not eliminated** — this needs to be
   understood before increasing size or leverage back up.
4. Treat the originally stated 30%/day performance target as aspirational,
   not a bar this backtest needs to clear — judge on real win rate/PF/
   drawdown instead, per the Targets section above.
