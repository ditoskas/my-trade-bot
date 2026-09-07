# EMA Crossover

**Status:** backtested — best result found: **ADX filter alone, no
minimum hold: +67.4%, profit factor 2.16.** Isolating the two changes
combined in the previous version showed the minimum-hold addition was
actually *hurting* results once ADX was already filtering well (ADX+hold
together: +30.5%; ADX alone: +67.4%) — a real, clean finding from
isolation testing, not a guess. `minHoldBars` defaults to 1 (disabled)
below. See "Backtest results (ADX alone — best so far)" for the full
comparison and honest caveats (same test window, no out-of-sample check
yet) before treating this as validated.

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
  slowEMA)`) **and** ADX confirms a real trend (`adxVal >=
  adxThreshold`) **and** the fast/slow gap at the cross isn't too wide
  (see the gap filter below).
- **Short**: fast EMA crosses below slow EMA (`ta.crossunder(fastEMA,
  slowEMA)`) **and** the same ADX and gap conditions.

**Trend filter switched from a 100-EMA to ADX.** The EMA version
("is price on the trend side of a slow average") had weak, inconsistent
correlation with trade PnL despite some win-rate effect (see Diagnostic
findings below). ADX measures trend *strength* directly rather than just
which side of a line price sits on, which is closer to what's actually
needed here — reject crossovers that fire during genuinely flat/choppy
conditions, not just ones on the "wrong side" of an average that itself
may be flat. Untested — replacing rather than combining with the EMA
filter specifically so any change in result can be attributed to this
swap alone, not a combination of two filters.

**Crossover gap filter kept** — after per-trade diagnostic logging (see
Diagnostic findings below) found that a wide fast/slow EMA separation *at
the moment of the cross* predicted worse trades — `gapPct =
|fastEMA - slowEMA| / close * 100` in the worst third of observed trades
(≥ ~0.06%) averaged -4.80 pnl, versus +0.87 for the better two-thirds.
Entries still require `gapPct <= maxGapPct` (default 0.06) — this part is
unchanged and already evidence-backed.

**Fast/slow lengths tested at 20/50, reverted back to 9/21** — see
"Backtest results (20/50 crossover — tried and rejected)" below. Widening
the signal itself made things worse (~-32%, and one single stretch lost
-307.68), for a different reason than the trend-filter case: a slower
crossover pair lags the actual turn, so it tends to catch *worse* entries
(price has already moved by the time it fires) rather than fewer bad
ones. Kept at 9/21.

**Added after the pre-fix backtest** (see Backtest results below): the
original version had no regime filter at all and whipsawed heavily during
DOGE's extended sideways stretches, reversing on nearly every crossover
even with no real trend behind it. A trend EMA filter rejects crossover
signals that go against the larger trend, on the theory that most of the
damage came from taking *both* sides of a crossover pair inside a range
rather than from any single bad signal.

**Trend EMA length tested at 50, reverted back to 100** — see "Backtest
results" below for both runs. The hypothesis going in was that a faster
trend EMA would filter *more* whipsaw signals; the actual result was the
opposite (~160 → ~220 trades, -16% → -31%). A 100-period EMA stays flat
enough to represent the real underlying trend; a 50-period one tracks
price too closely and moves with the same short-term noise the crossover
itself reacts to, so it stops meaningfully disagreeing with the crossover
and lets more whipsaw-prone signals through instead of fewer. Recorded
here so this isn't re-tried without remembering why it made things worse.

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
   reverses into) the position. Only one position open at a time, same
   convention as every other strategy in this project — a reversal
   signal doesn't stack a second position on top of the first.

**A minimum-hold-before-reversal mechanism exists in the code
(`minHoldBars`) but defaults to 1, which is effectively disabled** — it
was added on the theory that letting trades "breathe" past a quick
reversal would let more of them reach the trailing stop (see Diagnostic
findings below, where the rare trades that did reach it averaged a large
gain). Tested combined with the ADX filter (5-bar hold: +30.5%) and
isolated from it (ADX alone: +67.4%) — **the minimum hold made things
worse once ADX was already filtering out the weak crossovers**, not
better. Kept in the code as a parameter (in case it's useful combined
with a different filter later) but not used by default. See "Backtest
results (ADX alone — best so far)" for the isolation numbers.

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
| Fast EMA length | 9 | tested at 20, reverted — worse (-32% vs -16%) — see Entry logic |
| Slow EMA length | 21 | tested at 50, reverted — worse (-32% vs -16%) — see Entry logic |
| ~~Trend filter EMA length~~ | ~~100~~ | superseded by ADX below — kept in Backtest results for comparison |
| ADX/DI length | 14 | new — standard default, not calibrated |
| ADX smoothing | 14 | new — standard default, not calibrated |
| Min ADX (trend strength) | 20 | new — lenient starting threshold, not calibrated |
| Max crossover gap (% of price) | 0.06 | evidence-backed (per-trade diagnostic) — kept from the prior version |
| Minimum bars held before reversal | 1 (disabled) | tested at 5, combined with ADX it performed *worse* than ADX alone (+30.5% vs +67.4%) — see Exit rules |
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
adxLen                 = input.int(14, "ADX/DI length")
adxSmoothing           = input.int(14, "ADX smoothing")
adxThreshold           = input.float(20, "Min ADX (trend strength)")
leverage               = input.float(5, "Leverage (see margin_long/short note above)", minval = 1, maxval = 20, step = 1)
marginPct              = input.float(10, "Margin % of equity per trade")
stopMarginPct          = input.float(80, "Stop-loss: % of margin lost")
trailActivateMarginPct = input.float(100, "Trailing-stop activation: % of margin gained")
trailOffsetMarginPct   = input.float(20, "Trailing-stop offset: % of margin given back")
maxGapPct              = input.float(0.06, "Max fast/slow gap at cross (% of price)")
minHoldBars            = input.int(1, "Minimum bars held before a reversal can close position (1 = disabled - tested at 5, performed worse, see Exit rules)")

fastEMA = ta.ema(close, fastLen)
slowEMA = ta.ema(close, slowLen)
gapPct  = math.abs(fastEMA - slowEMA) / close * 100
[diPlus, diMinus, adxVal] = ta.dmi(adxLen, adxSmoothing)

// ---- Minimum-hold gate: lets an existing position ride out a too-quick
// reversal instead of being cut before the trailing-stop mechanism ever
// gets a chance to engage (per-trade diagnostics showed 95% of trades
// closed via reversal, averaging a small loss, while the rare trades that
// reached the trailing stop averaged a large gain) ----
var int entryBarIndex = na
barsHeld  = na(entryBarIndex) ? na : bar_index - entryBarIndex
canReverse = na(entryBarIndex) or barsHeld >= minHoldBars

// Raw crossover + ADX trend-strength filter (replaces the earlier 100-EMA
// trend filter - ADX measures whether a real trend exists at all, not
// just which side of a slow average price sits on) + the evidence-backed
// gap filter (a wide fast/slow gap at the cross means it fired late,
// after the move already ran).
rawLongSignal  = ta.crossover(fastEMA, slowEMA) and adxVal >= adxThreshold and gapPct <= maxGapPct
rawShortSignal = ta.crossunder(fastEMA, slowEMA) and adxVal >= adxThreshold and gapPct <= maxGapPct

// Only gate the reversal case (opposite side currently open) - a fresh
// entry from flat is never delayed by the minimum-hold rule.
longSignal  = rawLongSignal and (strategy.position_size >= 0 or canReverse)
shortSignal = rawShortSignal and (strategy.position_size <= 0 or canReverse)

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
    entryBarIndex := bar_index

if shortSignal
    entryPrice         = close
    stopPrice          = entryPrice * (1 + stopDistPct)
    trailActivatePrice = entryPrice * (1 - trailActivateDistPct)
    trailOffsetTicks   = (entryPrice * trailOffsetDistPct) / syminfo.mintick
    strategy.entry("Short", strategy.short, qty = f_qty(entryPrice))
    strategy.exit("Bracket-S", from_entry = "Short", stop = stopPrice, trail_price = trailActivatePrice, trail_offset = trailOffsetTicks)
    entryBarIndex := bar_index

plot(fastEMA, "Fast EMA", color = color.teal)
plot(slowEMA, "Slow EMA", color = color.orange)
plot(adxVal, "ADX", color = color.purple, display = display.data_window)
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

## Backtest results (50-EMA trend filter — tried and rejected)

Same window, same script, only `trendLen` changed from 100 to 50.

| Metric | 100-EMA (kept) | 50-EMA (rejected) |
|---|---|---|
| Ending equity | ~838 | ~690 |
| Total return | ~-16% | **~-31%** |
| Entries | ~160 | **~220** |
| Full flat-exits | 4 | 4 |

Worse on every count. Diagnosis above (Entry logic section) — a faster
trend EMA tracks price too closely to actually disagree with the
crossover, so it filters less, not more. Reverted to 100. Don't re-try
shortening this filter without a different mechanism (e.g. requiring the
trend EMA to be sloping, not just price on one side of it) — plain length
reduction moves in the wrong direction.

## Backtest results (20/50 crossover — tried and rejected)

Same window, same script, only `fastLen`/`slowLen` changed from 9/21 to
20/50 (trend filter back at 100).

| Metric | 9/21 (kept) | 20/50 (rejected) |
|---|---|---|
| Ending equity | ~838 | ~676 |
| Total return | ~-16% | **~-32%** |
| Entries | ~160 | ~117 |
| Largest single stretch loss | -962 (pre-fix, unfiltered) | **-307.68** |

Worse despite fewer trades — confirms this isn't simply "fewer trades is
better." A slower crossover pair lags the actual price turn, so its
entries land later and worse, not cleaner.

## Summary across all four runs tested so far

| Config | Return | Entries |
|---|---|---|
| 20x/30%, no filter (pre-fix) | -94.4% | ~150 |
| 5x/10%, 9/21, 100-EMA filter | **-16%** (best) | ~160 |
| 5x/10%, 9/21, 50-EMA filter | -31% | ~220 |
| 5x/10%, 20/50, 100-EMA filter | -32% | ~117 |

Every parameter change tried after the initial leverage fix made things
worse. That's a real signal, not bad luck: a plain EMA-crossover-plus-
trend-filter design may not have an edge on DOGEUSDT.P 1h at all, at
least not one reachable by nudging these particular lengths. Worth
treating the current 9/21/100 config as a local optimum of a
fundamentally weak design, not a strategy one parameter tweak away from
working.

## Diagnostic findings (per-trade PnL, 9/21/100 config, 159 closed trades)

Built a v5 diagnostic script that logs a `CLOSE` line for **every** trade
exit (reversal *or* stop/trail), not just full flat-exits like the
earlier diagnostic versions — those only ever caught 4-5 trades out of
150+, blind to the other 97%. Parsed programmatically (grep/awk over the
downloaded log), not by hand. Total pnl -161.82 (matches the ~-16%
result), win rate 35.2%, profit factor 0.81.

**Trades close almost entirely via reversal, and reversals lose on
average**: 155 of 159 trades closed on the opposite crossover firing;
those averaged **-1.79** each. Only 4 ever ran far enough to hit the
stop/trail, averaging +29 each (too small a sample to trust alone, but
consistent with "letting a trade run further is good, most get cut by a
reversal too early to know").

**Crossover gap size at entry — acted on, see Entry logic above**: a wide
fast/slow EMA gap at the moment of the cross (the cross fired late, after
price had already moved) predicted materially worse trades. Splitting
159 trades into thirds by gap size:

| Gap tercile | Trades | Win rate | Avg PnL |
|---|---|---|---|
| Narrowest | 53 | 43.4% | **+1.56** |
| Middle | 53 | 28.3% | +0.18 |
| Widest | 53 | 34.0% | **-4.80** |

**Direction asymmetry — noted, not acted on**: shorts were ~breakeven,
longs clearly lost.

| Side | Trades | Win rate | Avg PnL |
|---|---|---|---|
| SHORT | 93 | 39.8% | +0.53 |
| LONG | 66 | 28.8% | -3.2 |

Not applied as a filter: DOGE fell ~40% over this exact test window
(Jan–Sep 2026), so "shorts did better" may just reflect the test period's
downtrend rather than a structural edge — the gap-size finding above
doesn't have that regime-dependency problem, which is why it was acted
on first and this wasn't.

**Trend-filter distance — weak, not acted on**: win rate rose with
distance from the trend EMA (21% → 49% across terciles) but average PnL
didn't improve cleanly alongside it, so this wasn't as clean or
trustworthy a lever as the gap-size finding.

## Backtest results (gap filter added — best result so far)

Same window, same script, `maxGapPct = 0.06` added on top of the 9/21/100
config. Parsed the same way (grep/awk over the downloaded log).

| Metric | No gap filter | With gap filter |
|---|---|---|
| Ending equity | ~838 | **~938** |
| Total return | ~-16% | **~-6.2%** |
| Trades | 159 | 104 (-35%) |
| Win rate | 35.2% | 32.7% |
| Profit factor | 0.81 | **0.91** |

Real improvement on every profitability metric, though trade count
dropped more than the in-sample tercile math implied it would (removing
crosses reshuffles which reversals happen at all downstream, not just
which ones are removed — expected, not a red flag). Frequency is now
~1 trade per 2.4 days, a bit below the original 1/day target but still
reasonable. **Still net negative** — this is progress, not a finished
strategy. This backtest is on the *same* window the filter was derived
from, so some of the improvement could be curve-fit to this specific
8 months rather than a durable effect — worth keeping in mind before
trusting the magnitude, even though the *direction* (tight gaps beat wide
gaps) has a real mechanical explanation (late cross = already-run move),
not just a statistical artifact.

## Backtest results (ADX + minimum hold — first profitable result)

Same window, gap filter kept, 100-EMA trend filter replaced with ADX
(≥20), plus a 5-bar minimum hold before a reversal can close a position.
Parsed the same way (grep/awk over the downloaded log).

| Metric | Gap filter only | + ADX + min-hold |
|---|---|---|
| Ending equity | ~938 | **~1305** |
| Total return | ~-6.2% | **+30.5%** |
| Trades | 104 | 64 |
| Win rate | 32.7% | 35.9% |
| Profit factor | 0.91 | **1.48** |
| Avg PnL, reversal exits | -0.59 (n=59) | closer to breakeven than every prior version |
| Avg PnL, stop/trail exits | n/a | **+68 (n=5)** |

First genuinely profitable configuration across every version tested in
this strategy's history. The reason-breakdown confirms the theory that
motivated the minimum-hold change: trades that survive long enough to
reach the trailing stop are now a meaningful contributor (+68 avg on 5
trades) rather than a near-nonexistent edge case, while reversal exits
(still the majority, 59/64) moved from a clear loss on average to
roughly breakeven.

**Honest caveats before trusting this**:
- **Frequency dropped further** — 64 trades over ~8 months is ~1 every
  3.8 days, well below the original ~1/day-to-1/2-days target.
  Profitability came partly at the cost of frequency; if trade frequency
  matters as much as the original goal implied, this trade-off needs a
  deliberate decision, not just acceptance.
- **Two changes were combined** (ADX swap + minimum hold) at the user's
  request — this result can't yet say which one did the work, or whether
  they're both necessary together. Worth an isolated test of each before
  fully trusting the combination.
- **Still the same 8-month window** every other version was tested and
  tuned against — none of this has been checked out-of-sample yet. A
  design that's now been adjusted five times against the same data has a
  real risk of being overfit to this particular period's price action,
  regardless of how mechanically reasonable each individual change is.

## Backtest results (ADX alone, no minimum hold — best so far)

Same window, same script, `minHoldBars` set to 1 (disabled) to isolate
the ADX filter's effect from the minimum-hold change tested together
above.

| Metric | Gap filter only | ADX + 5-bar hold | **ADX alone** |
|---|---|---|---|
| Ending equity | ~938 | ~1305 | **~1674** |
| Total return | ~-6.2% | +30.5% | **+67.4%** |
| Trades | 104 | 64 | 75 |
| Win rate | 32.7% | 35.9% | 34.7% |
| Profit factor | 0.91 | 1.48 | **2.16** |
| Avg PnL, reversal exits | — | -0.59 | **+4.23** |
| Avg PnL, stop/trail exits | — | +68 (n=5) | +75.62 (n=5) |

**Clean, important finding from isolation testing**: the minimum-hold
change was not neutral — it actively made things worse once ADX was
already doing the filtering. With ADX alone, reversal exits (still 70 of
75 trades) average a small *gain* (+4.23), not a small loss — the ADX
filter alone is apparently good enough at picking crossovers that even
the "premature" reversal exits tend to be net positive, and forcing
trades to hold longer past a reversal signal (as the minimum-hold change
did) was overriding a signal that was often *right*, not just noise.
This is now the best-performing config found across every version
tested. `minHoldBars` defaults to 1 (disabled) as of this result.

**Same caveats still apply**: single 8-month window, no out-of-sample
check yet, and the cross-timeframe check below was run against the older
ADX+minimum-hold version, not this one — worth re-running on 30m/4h with
minimum-hold disabled before trusting those numbers too.

## Cross-timeframe check, re-run with ADX alone (minHoldBars=1)

Same script/parameters as the best config above (9/21 EMA, ADX≥20,
gap≤0.06%, minimum hold disabled), re-tested on other timeframes now
that ADX alone (not combined with minimum hold) is the leading config.

| Timeframe | ADX + 5-bar hold (old) | **ADX alone (current)** |
|---|---|---|
| 30m | -7.9% | **+0.81%** |
| **1h (primary)** | +30.5% | **+67.4%** |
| 4h | +9% | +6.85% |

**All three timeframes are now positive** with ADX alone, where the
combined config had 30m going negative. That's a meaningfully better
robustness signal than before — the ADX filter by itself seems to
generalize across timeframes more consistently than it did paired with
the minimum-hold rule, consistent with the isolation finding above (the
minimum hold was overriding signals that were often already correct).
1h remains by far the strongest, but this is no longer "works on 1h,
breaks elsewhere" — it's "works everywhere, works best on 1h."

(The old combined config's 30m weakness made sense in hindsight: 5 bars
is a very different real-world duration depending on the chart —
2.5 hours on 30m, 5 hours on 1h, 20 hours on 4h — so `minHoldBars` as a
fixed *bar count* rather than a fixed *time duration* made that version
more timeframe-specific than intended. Removing it removed that
sensitivity too.)

## Next steps

1. ~~Re-run the cross-timeframe check with `minHoldBars=1`~~ — **done**,
   see above: all three timeframes (30m +0.81%, 1h +67.4%, 4h +6.85%) are
   now positive, a meaningfully better robustness signal than the
   combined config's negative 30m result.
2. **Test on a different time window or symbol** before trusting this
   result — every version of this strategy has been tuned against the
   same Jan–Sep 2026 DOGEUSDT.P data, which is the single biggest
   remaining risk to everything found so far.
3. **Decide deliberately whether the frequency trade-off is acceptable** —
   75 trades/8 months (~1 every 3.3 days) is a real departure from the
   original ~1/day goal that started this whole strategy; if frequency
   matters independently of profitability, this needs a conscious call,
   not silent acceptance.
4. Only after 1-3 above: consider whether this is ready for the diagnostic-
   free finalized script, then paper trading — not before.

<!-- Superseded next-steps from the gap-filter-only stage, kept for
     history rather than deleted: -->

1. **This is progress, not a finished strategy — PF is 0.91, still <1.**
   Before declaring the gap filter validated, ideally test it against a
   different time window or symbol to check it's not fit to this
   specific 8-month period.
2. **If the gap filter holds up, consider testing the direction asymmetry
   next, but on a different time window first** — the long/short split
   found earlier is confounded with this specific 8-month downtrend and
   needs out-of-sample confirmation before being turned into a rule.
3. **Stop tuning EMA lengths blind — every attempt after the leverage fix
   has made things worse.** Two independent directions (shorter filter,
   longer signal) both failed for different, real reasons (less filtering
   vs. more lag), which is itself evidence this design's ceiling may just
   be "loses less badly" rather than "profitable," at least on
   DOGEUSDT.P 1h. Don't keep nudging fastLen/slowLen/trendLen by feel —
   the next test should target *why* trades lose, not another length.
4. **If the gap filter turns out not to help out-of-sample**, the honest
   conclusion is that a plain EMA-crossover-plus-trend-filter doesn't have
   a reachable edge on this symbol/timeframe, and the right move is to
   retire this approach (see `delete-strategy`/mark `retired`) rather than
   keep tuning — matching this project's own precedent of calling a
   strategy's real gaps honestly (see `ma-cross-demo.md`).
5. Given the ~34% drawdown from peak still happened with the filter in
   place (best config), **chop risk is reduced, not eliminated** — relevant
   if any variant of this is ever reconsidered for capital.
6. Treat the originally stated 30%/day performance target as aspirational,
   not a bar this backtest needs to clear — judge on real win rate/PF/
   drawdown instead, per the Targets section above.
