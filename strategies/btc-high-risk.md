# BTC High-Risk

**Status:** draft, iteration 15 for the Pine script — a 4h candle wick-
ratio entry filter (only trade when the 4h candle at entry shows real
rejection, not a clean trending candle) took this to +$617.22 (+61.72%),
PF 1.602, DD 16.57%, live-verified — the best result in this strategy's
history by a wide margin, nearly tripling iteration 14's total PnL while
*improving* drawdown at the same time. A stricter threshold tested even
higher (+$761.28, PF 2.051) but on a much smaller sample; kept the more
conservative setting deliberately — see Backtest results and Next steps.
The engine port described below (`apps/engine`'s `BtcHighRiskStrategy`) has
since been updated for iteration 15's wick filter, and a real root-cause
bug behind the port's signal-parity gap (the pivot detector's tie-breaking
rule) has been found and fixed — see "Engine port" below. The gap is
narrowed, not yet re-verified as closed.

Iteration 14 dropped the 38.2% level (same treatment as 61.8%, same
diagnostic method), reaching +$232.02 (+23.20%), PF 1.18, live-verified.
Only the 50.0% and 78.6% Fib levels remain tradeable. Ported to
`apps/engine` as `BtcHighRiskStrategy`
and running on Binance futures **testnet** (real exchange calls, fake
funds) — see "Engine port" below for what that port found, including an
**unresolved signal-parity gap** against this Pine backtest that means the
port is not yet trusted for real capital. See Status detail below and
Backtest results. Iteration 1 (Fibonacci entries + structural/
capped stop + 100%-or-4h-level take profit) was tested in four
configurations, live; every one landed in the same 0.5-0.6 profit-factor
range. Iteration 2 stripped the strategy to entries-only, holding until the
next opposite signal (no stop, no target) — confirmed as the exit style to
keep: avg win/loss came out roughly balanced (+$168.87 / -$185.35), a big
improvement over iteration 1's 5.4:1 imbalance, but still net negative
(-102.01%, PF 0.646, win rate 42.31%). Iteration 3 added a 4h ADX
trend-strength filter to try to fix the win rate — tested live, made it
slightly worse (37.50% win rate, PF 0.596), a real negative result stated
plainly rather than rationalized. Iteration 4 keeps the reversal-hold exit
and drops the ADX filter, but fixes something more fundamental: the swing
used for the Fibonacci levels was the highest-high/lowest-low over a fixed
rolling 72-bar window, which can span multiple unrelated legs and silently
shift every bar as old candles fall out of the window — not an actual
identified "bottom to top" or "top to bottom" move. Replaced with genuine
pivot-based swing detection (confirmed local highs/lows via
`ta.pivothigh`/`ta.pivotlow`), anchoring the Fib levels to one real,
identifiable swing. **Live-verified, best result in this strategy's history
so far**: 58.46% win rate, PF 0.747 — after catching and fixing a real bug
in the trend-direction comparison (see Backtest results) that had the
strategy buying dips through an entire real bear market. Still net negative
overall (-107.37%) because a single -7.69% trade wiped out most of an
otherwise-strong equity curve — the clearest evidence yet that entry quality
isn't the problem, the total absence of a stop loss is.

Following web research into how high-leverage crypto scalpers actually
manage risk (see Backtest results for sources and specifics), iterations 5
and 6 added exactly the two things that research said were missing:
iteration 5 a flat **-1% max-loss stop** (wins still ride to the next
opposite signal; only the loss side is now capped), and iteration 6
**risk-based position sizing** — margin per trade is now derived so that
hitting the stop always costs a fixed % of *current* equity (compounding),
replacing the flat $50-200-regardless-of-account-size table. Both
live-verified together: total return improved to -79.20% (from -107.37%)
and max drawdown improved to 82.83% (from 100%+), but trade count exploded
from 65 to **695** — the pivot-based swing whipsaws rapidly during choppy
stretches, each tiny swing producing its own tiny, immediately-reachable
Fib levels. Iterations 7 and 8 both target that directly and are being
tested together: a **minimum swing size filter** (sit out swings too small
to be worth trading) and **4h trend confirmation** (only trade when the 1h
and 4h pivot-based trend directions agree) — the latter added on direct
request while iteration 7 was still being written up. **Live-verified
together**: trade count fell from 695 to **192** (both filters doing real
work cutting noise), total return improved to -50.02% (from -79.20%), max
drawdown improved to 56.78% (from 82.83%) — but win rate fell further to
34.90%. The payoff ratio is now genuinely favorable (avg win $20.08 vs avg
loss -$14.77, ~1.36:1) — this needs roughly 42% win rate to break even, and
34.90% isn't there yet, but it's closer than any version before it.

Iteration 9 tried adding EMA(9/21) + VWAP confluence on top, per the web
research cited in Backtest results (real short-term setups trade Fibonacci
as one leg of confluence, not alone). **Tested live and made things much
worse** — win rate fell to 17.65%, PF to 0.272 — likely because requiring
price above VWAP and EMA9>EMA21 for a long directly contradicts the Fib
logic's whole premise (buying a pullback means price has already dropped
below recent structure, which tends to coincide with EMA9 dipping below
EMA21 and price sitting below VWAP — exactly what the filter rejected). A
real negative result, stated plainly rather than rationalized. **Reverted**
— iteration 8 (no confluence gate) is the current baseline.

Iteration 10 adds a **minimum 4h zone width** check on top of iteration
8: the 4h pivot high-to-low range is now also required to be at least
`minZoneWidth` (default $2000) before a trade is allowed, on the theory
that a narrow 4h range signals an indecisive market rather than a real
trending structure. **Live-verified — a modest, mixed result**: trades
fell further (192→163), total return and drawdown both improved slightly
(-50.02%→-45.14%, 56.78%→54.02%), and the payoff ratio actually improved
to ~1.68:1 (avg win $24.06 vs avg loss -$14.31) — but win rate fell to
30.06% (from 34.90%), landing at roughly the same distance from its
now-higher breakeven point (~37.3%). Net effect: a lateral move, not a
clear win like iterations 7-8 were.

Rather than tune another filter blind, went back to diagnosing real trade
data (the same technique that found `short-term-high-risk`'s session
filter): added temporary `log.info()` diagnostics to iteration 10 and
cross-referenced all 164 signals against outcome. ADX and 4h zone width
showed no separation between winners and losers. Two real patterns did:
the 61.8% Fib level had a 16.7% win rate vs. 38.2%'s 40% (not yet acted
on), and — the big one — **night-session trades (20:00-06:00 UTC) were
profitable (+$82.5) while day-session trades (07:00-19:00 UTC) accounted
for essentially the entire loss (-$534.0)**. Note this is the *opposite*
session from `short-term-high-risk`'s finding — different symbol,
timeframe, and mechanism, no contradiction, just worth not assuming one
strategy's session pattern transfers to another.

**Iteration 11 adds a night-session-only filter** (20:00-06:00 UTC) on top
of iteration 10. **Live-verified: +$102.36 (+10.24%), PF 1.06, 23.23% win
rate (23/99), max drawdown 29.37%** — the first profitable configuration
in this strategy's entire history. Avg win $62.10 vs avg loss -$18.27 (a
~3.4:1 payoff ratio) needs only ~22.7% win rate to break even, and 23.23%
clears it. Real, but a thin margin on one BTCUSDT window — not yet
re-verified elsewhere.

**Iteration 12** replaces the independent `maxLossPct` stop input (which
happened to equal 1.0%, the same as 100x leverage's liquidation distance,
but wasn't actually *tied* to leverage) with a stop computed directly as
`1/leverage` — "allow the position to fully liquidate (100% loss) but not
more," by construction, for whatever leverage is actually set, rather than
a fixed number that would silently stop being correct if leverage changed.
This also simplifies the risk-based position-sizing formula: since the
stop now always costs exactly 100% of margin, "risk X% of equity" collapses
to directly allocating X% of equity as margin (the leverage/stop-distance
terms in the old formula cancel out exactly once the stop *is* the
liquidation point). **Live-verified**: +$101.77 (+10.18%), PF 1.06, 23.23%
win rate (23/99) — mathematically equivalent to iteration 11 at 100x (since
1/100 = 1.0%, the same number as before), confirming the refactor is
correct; the real benefit is that the stop now automatically follows
leverage if it's ever changed, instead of needing two numbers kept in sync
by hand.

**Iteration 13 re-ran the diagnostic-logging technique against the
current (post-session-filter) trade set** to check whether the 61.8%
level's weak win rate — flagged back in iteration 10's diagnostic pass,
never yet acted on — still held once the sample changed from 164 signals
down to 99. It did, and was worse than before: broken out by level on the
live 99-trade sample, **61.8% ran 10.5% win rate (2/19), PF 0.322, -$265.03
total** — the only level with a negative profit factor, dragging heavily
on an otherwise-positive book (38.2%: 20.0% WR, PF 0.401, -$64.59; 50.0%:
38.5% WR, PF 2.498, +$153.53; 78.6%: 26.2% WR, PF 1.330, +$259.32). Rather
than reduce its risk allocation (the other option flagged in iteration 11's
Next steps), dropped it entirely: a retracement that reaches the
61.8%-78.6% band but not 78.6% itself is now simply not traded, instead of
being reclassified into a neighboring level's sizing. **Live-verified:
+$194.89 (+19.49%), PF 1.136, 24.47% win rate (23/94), max drawdown
26.77%** — nearly double iteration 12's total PnL, better profit factor,
and better drawdown, from removing a single Fib level. Confirms the
original diagnostic finding was real and durable across two different
sample sizes/date-filtered subsets, not a one-off artifact.

## Overview

Single-symbol BTCUSDT.P, **100x leverage**, entries driven by Fibonacci
retracement levels against a dynamically-detected 1h trend. No exit logic
exists except reversal — a new signal in the opposite direction closes the
existing position and opens the new one (the same idiom `ma-cross-demo.md`
uses), and a repeat signal in the same direction is a no-op (Pine's default
no-pyramiding behavior blocks a duplicate same-side entry). This makes the
backtest a direct measure of "was this entry timing right, held until the
next opposing signal" — not entangled with any particular stop or target
design.

## Entry logic

1. **Swing detection (iteration 4 — pivot-based, not a rolling window)**:
   uses `ta.pivothigh`/`ta.pivotlow` on the 1h chart (`pivotLeftRight` bars
   of confirmation on each side, default 5) to find genuine, confirmed local
   swing points, and tracks the most recent confirmed pivot high and pivot
   low. This replaced iteration 1-3's approach (highest-high/lowest-low over
   a fixed rolling 72-bar window), which could span multiple unrelated legs
   and would silently shift the levels every bar as old candles aged out of
   the window — not an actual identified "bottom to top" or "top to bottom"
   move. Pivot detection introduces `pivotLeftRight` bars of confirmation
   lag (can't know a pivot happened until that many bars pass) — an honest,
   bounded delay, not repainting.
2. **Trend direction**: whichever of the two most recent confirmed pivots is
   more recent determines the leg. Pivot low more recent than pivot high →
   the last completed leg was low→high (an up-move) → **bullish**, price
   presumed retracing down from that high. Pivot high more recent → the last
   leg was high→low (a down-move) → **bearish**, retracing up from that low.
3. **Fibonacci levels** — 38.2%, 50%, 61.8%, 78.6% — computed down from the
   pivot high (bullish) or up from the pivot low (bearish), same formula as
   before, just anchored to real pivots now instead of window extremes.
4. **Entry trigger**: on a bullish trend, if the bar's low touches a Fib
   level, go long, sized per that level (see Position sizing) — checked
   deepest level first so a gap through multiple levels enters at the
   deepest one actually reached. Bearish is the exact mirror (bar's high
   against the same levels, go short).
5. No trend-strength filter — iteration 3's ADX filter was tested and made
   results slightly worse, dropped. No session filter.
6. **Minimum swing size (iteration 7)**: only trades a
   swing if the pivot-high-to-pivot-low range is at least `minSwingPct`% of
   price. Added after iterations 5-6 (stop-loss + risk-based sizing) drove
   trade count from 65 to 695 — the pivot detector whipsaws rapidly during
   choppy stretches, each tiny swing producing its own tiny,
   immediately-reachable Fib levels, and the user flagged the resulting
   pile of near-breakeven trades directly. This filter sits out swings too
   small to be worth trading rather than trying to fix it after the fact.
7. **4h trend confirmation (iteration 8)**: computes
   the same pivot-based trend direction independently on the 4h timeframe
   (via `request.security`) and only allows a trade when the 1h and 4h
   trend agree — a 1h bullish retracement setup is skipped if the 4h
   pivots currently read bearish, and vice versa. Directly requested to cut
   trade count/noise further by requiring both timeframes to actually
   agree, not just the 1h swing in isolation.
8. **EMA/VWAP confluence — attempted in iteration 9, reverted.** Tried
   requiring EMA(9) > EMA(21) and close above the session VWAP for a long
   (mirror for short), on the theory that real short-term crypto setups
   trade Fibonacci as one leg of confluence rather than alone. Made results
   much worse live (win rate 34.90%→17.65%, PF 0.729→0.272) — the filter
   likely rejects exactly the pullback entries the Fib logic is designed to
   catch, since a real dip tends to coincide with EMA9 briefly below EMA21
   and price below VWAP. Not carried forward — see Backtest results.
9. **Minimum 4h zone width (iteration 10)**: the 4h
   pivot high-to-low range from iteration 8's trend confirmation is now
   also checked as a support/resistance zone width — if that range is
   narrower than `minZoneWidth` (default $2000), the trade is skipped even
   if direction and the 1h Fib level otherwise line up. A tight 4h zone
   means the market is in an indecisive, narrow range rather than a
   meaningful trending structure — directly requested to cut further
   low-quality trades that iterations 7-8's filters still let through.
10. **Night session only (iteration 11)**: only trades 20:00-06:00 UTC.
    Found by diagnostic logging (not theorized) — night-session signals were
    profitable (+$82.5) while day-session signals accounted for essentially
    the entire loss (-$534.0) on the same 164-signal sample. First filter in
    this strategy's history to flip the whole backtest profitable.
11. **61.8% level dropped entirely (iteration 13)**: a retracement that
    reaches the 61.8%-78.6% band but doesn't reach 78.6% itself is no longer
    traded at all. Found by re-running the same diagnostic-logging technique
    against the current (post-session-filter) 99-trade sample: 61.8% ran
    10.5% win rate (2/19), PF 0.322, -$265.03 — the only level with a
    negative profit factor, and worse than iteration 10's earlier read on
    this level (16.7% WR on the larger, pre-filter sample), confirming the
    weakness is real and durable, not a one-off. Live-verified: total PnL
    nearly doubled (+$101.77 → +$194.89), PF improved (1.06 → 1.136), and
    drawdown improved (29.37% → 26.77%) — see Backtest results.
12. **38.2% level also dropped entirely (iteration 14)**: same treatment,
    same diagnostic method, re-run against the fresh 94-trade sample
    created by dropping 61.8%. 38.2% was already the second-weakest level
    at iteration 13 (20.0% WR, PF 0.401) and got worse on the new sample
    (17.9% WR, 5/28, PF 0.389, -$79.58) — a real, durable weakness across
    two different trade samples, not noise. Only 50.0% and 78.6% remain
    tradeable now. Live-verified: total PnL improved again (+$194.89 →
    +$232.02), PF improved (1.136 → 1.18), though trade count dropped
    sharply (94 → 74, since only two levels can trigger an entry now) and
    drawdown ticked up slightly (26.77% → 27.92%).
13. **4h candle wick-ratio filter (iteration 15)**: an entry is only taken
    if the 4h candle containing it has a wick ratio (`1 - |close-open| /
    (high-low)`) of at least `minWick4hRatio` (default 0.5) — i.e. the 4h
    candle must show real rejection (a big wick relative to its range),
    not a clean, mostly-body trending candle. Found via a fresh diagnostic
    pass explicitly requested by the user: analyzed real 15m and 4h
    context around all 74 of iteration 14's trades (fetched directly from
    Binance, not guessed) and compared winners against losers. Winners'
    4h candle averaged a 0.635 wick ratio vs losers' 0.549 — a real,
    intuitive pattern: a big wick suggests genuine exhaustion/rejection at
    this level (consistent with a reversal), while a clean low-wick candle
    suggests strong continuation momentum fighting a counter-trend Fib
    entry. A threshold sweep on that same data showed a strong, real
    effect (not just noise at one arbitrary cutoff): 0.5 → 45 trades, PF
    1.663; 0.6 → 33 trades, PF 2.341 (both far above the unfiltered 1.18).
    Live-verified in Pine (the authoritative number, not the offline
    estimate): 0.5 → +$617.22, PF 1.602, DD 16.57%, 56 trades; 0.6 →
    +$761.28, PF 2.051, DD 15.47%, 40 trades. Kept **0.5** deliberately —
    see Backtest results and Next steps for why, and for revisiting 0.6.

## Stop loss logic

**Liquidation-point stop** (iteration 5, redefined in iteration 12), set at
entry and never adjusted: long stop = `entryClose × (1 − 1/leverage)`,
short is the mirror. This does not replace the reversal exit for winners —
it only caps the loss side. Originally a flat, independently-configured
`-1%` (iteration 5), added in response to iteration 4's single -7.69%
trade wiping out most of an otherwise-strong equity curve, and matching
web research on real high-leverage scalping practice: cap the stop-out
cost at a fixed, small amount rather than letting it float with market
structure (see Backtest results for sources). Iteration 12 redefined the
stop distance as exactly `1/leverage` instead of an independent number
that happened to equal that at 100x — "allow the position to fully
liquidate (100% loss) but not more," tied directly to whatever leverage is
actually set, so it can never silently drift out of sync if leverage
changes.

## Take profit logic

**None** — wins still ride until the next opposite signal (reversal-only),
unchanged from iteration 2's finding that this produces a better payoff
ratio than a nearby fixed/structural target.

## Exit rules

- **Stop-loss** (iteration 5, redefined in iteration 12): a `-1/leverage`
  (100% margin loss) adverse move from entry closes the position
  immediately.
- A signal in the **opposite** direction from the current position closes
  it and opens the new one (Pine's standard reversal behavior when
  `strategy.entry()` is called for the other side) — this is still how
  winners exit.
- A signal in the **same** direction as an already-open position is a
  no-op — Pine's default `pyramiding=0` blocks a duplicate same-side entry.
- No time-based exit, no take-profit target.

## Position sizing

- **Leverage: 100x**, fixed.
- **Risk-based sizing (iteration 6, simplified in iteration 12)**,
  replacing iteration 1-5's flat $50-200 table: margin per trade is a fixed
  **% of current equity** (compounding), not a fixed dollar amount
  regardless of account size. Originally
  `margin = (equity × riskPct / 100) / (leverage × maxLossPct / 100)`;
  since iteration 12 made the stop always cost exactly 100% of margin by
  construction, that formula collapses to simply `margin = equity ×
  riskPct / 100` — the leverage and stop-distance terms cancel out exactly.
  riskPct still scales with which Fib level triggered entry (deeper
  retracement = more risk budget). **61.8% dropped in iteration 13, 38.2%
  dropped in iteration 14** (diagnostic found both were the only levels
  with a negative profit factor, on two different trade samples — see
  Entry logic and Backtest results) — retracements landing in either band
  are no longer traded, not resized. Only two levels remain active:

  | Level | Risk % of equity |
  |---|---|
  | 38.2% | *(not traded, iteration 14)* |
  | 50.0% | 1.0% |
  | 61.8% | *(not traded, iteration 13)* |
  | 78.6% | 2.0% |

- Notional exposure = margin × 100.

## Targets

- **Market regime**: trades with whichever 1h trend the most recent pivot
  pair implies, gated by minimum swing size (iteration 7), 4h zone width
  (iteration 10), and now restricted to the 20:00-06:00 UTC session
  (iteration 11) — no trend-strength filter (iteration 3's ADX gate was
  tested and dropped).
- **Performance expectation**: iteration 13 is net profitable (+19.49%,
  PF 1.136) on the one BTCUSDT window tested — the best result in this
  strategy's history so far. Still exploratory; not yet re-verified on a
  different range or symbol.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Leverage | 100x | Fixed |
| Pivot confirmation (bars each side) | 5 | iteration 4 |
| Max loss per trade | `1/leverage` (=1.0% at 100x) | iteration 5, tied to leverage in iteration 12 |
| Minimum swing size (% of price) | 1.5% | iteration 7 |
| Risk % of equity at 38.2% | *(not traded)* | iteration 6, dropped in iteration 14 |
| Risk % of equity at 50.0% | 1.0% | iteration 6 |
| Risk % of equity at 61.8% | *(not traded)* | iteration 6, dropped in iteration 13 |
| Risk % of equity at 78.6% | 2.0% | iteration 6 |
| Min 4h zone width ($) | $2000 | iteration 10 |
| Session start hour (UTC) | 20 | iteration 11 |
| Session end hour (UTC) | 6 | iteration 11 |
| Min 4h candle wick ratio at entry | 0.5 | iteration 15 — 0.6 tested stronger (PF 2.051 vs 1.602) but on a smaller sample (40 vs 56 trades); worth revisiting if a larger out-of-sample test still favors it |

## Pine Script v6

Runs on the **1h chart**. One `request.security` call (iteration 8) pulls
the same pivot-based trend logic (plus zone width, iteration 10) computed
independently on the 4h timeframe, with `lookahead=barmerge.lookahead_off`
(the same safe pattern `short-term-high-risk` uses).

```pinescript
//@version=6
strategy(
     "BTC High-Risk",
     overlay=true,
     default_qty_type=strategy.fixed,
     default_qty_value=0,
     initial_capital=1000,
     currency=currency.USDT,
     // Simulates 100x leverage (100/100 = 1). COMPILE-TIME CONSTANT — Pine
     // does not allow margin_long/margin_short to reference an input
     // variable, so this literal must be hand-edited if leverage changes.
     margin_long = 1,
     margin_short = 1,
     commission_type = strategy.commission.percent,
     commission_value = 0.05)

// ---- Inputs ----
leverage         = input.float(100, "Leverage (see margin_long/short note above)", minval = 1, maxval = 125, step = 1)
pivotLeftRight   = input.int(5, "Pivot confirmation (bars each side)")
minSwingPct      = input.float(1.5, "Minimum swing size to trade (% of price, iteration 7)")
riskPct500       = input.float(1.0, "Risk % of equity at 50.0% (iteration 6)")
riskPct786       = input.float(2.0, "Risk % of equity at 78.6% (iteration 6)")
minZoneWidth     = input.float(2000, "Min 4h zone width ($) to allow a trade (iteration 10)")
sessionStartHour = input.int(20, "Session start hour (UTC, inclusive, iteration 11)")
sessionEndHour   = input.int(6, "Session end hour (UTC, inclusive, iteration 11)")
minWick4hRatio   = input.float(0.5, "Min 4h candle wick ratio at entry (iteration 15)", minval = 0, maxval = 1, step = 0.05)

// ---- Liquidation-tied stop (iteration 12) ----
// Stop distance is now exactly 1/leverage -- the theoretical 100%-of-margin
// loss point -- instead of an independently-set maxLossPct that happened to
// equal this at 100x but wouldn't automatically follow if leverage changed.
// "Allow the position to fully liquidate (100% loss) but not more" -- this
// is that, tied directly to whatever leverage is actually set.
liqLossFrac = 1 / leverage

// ---- Pivot-based swing detection (iteration 4) ----
// Replaces iteration 1-3's ta.highest/ta.lowest-over-a-fixed-window approach,
// which could span multiple unrelated legs and would silently shift the
// levels every bar as old candles aged out of the window. This anchors the
// Fib levels to one real, confirmed swing instead.
ph = ta.pivothigh(high, pivotLeftRight, pivotLeftRight)
pl = ta.pivotlow(low, pivotLeftRight, pivotLeftRight)

var float lastPivotHigh    = na
var float lastPivotLow     = na
var int   lastPivotHighBar = na
var int   lastPivotLowBar  = na

if not na(ph)
    lastPivotHigh    := ph
    lastPivotHighBar := bar_index - pivotLeftRight
if not na(pl)
    lastPivotLow    := pl
    lastPivotLowBar := bar_index - pivotLeftRight

haveSwing = not na(lastPivotHigh) and not na(lastPivotLow)
diff      = lastPivotHigh - lastPivotLow

// Minimum swing size filter (iteration 7): the pivot detector can whipsaw
// rapidly during choppy stretches, each tiny alternating swing producing
// its own tiny, immediately-reachable Fib levels -- verified live as the
// cause of trade count exploding from 65 (iteration 4) to 695 (iteration
// 6) once a stop-loss let positions close and re-enter quickly instead of
// only ever exiting on a slow opposite-signal reversal. This sits out any
// swing too small to be worth trading at all.
validSwing = haveSwing and (diff / lastPivotLow * 100) >= minSwingPct

// Pivot high more recent (LARGER bar_index, since bar_index counts forward)
// than pivot low -> last completed leg was low->high (an up-move) ->
// bullish, now presumed retracing down from that high.
//
// Real bug caught live testing this: a first version compared these the
// same way iteration 1-3's ta.highestbars/ta.lowestbars version did
// ("lastPivotLowBar > lastPivotHighBar" for bullish) without noticing that
// ta.highestbars/lowestbars return a "bars ago" count (LARGER = OLDER),
// while bar_index is an absolute index (LARGER = MORE RECENT) -- the
// opposite direction. That inverted version called a sustained downtrend
// "bullish" the whole way down, and the backtest showed exactly that: 8
// months of real BTCUSDT decline (Jan-Sep 2026, ~93k to ~80k) produced a
// strategy that kept trying to buy dips in a bear market (PF 0.04).
// Comparison direction fixed below.
isBullish = validSwing and lastPivotHighBar > lastPivotLowBar
isBearish = validSwing and lastPivotLowBar > lastPivotHighBar

fib382 = isBullish ? lastPivotHigh - diff * 0.382 : lastPivotLow + diff * 0.382
fib500 = isBullish ? lastPivotHigh - diff * 0.5   : lastPivotLow + diff * 0.5
fib618 = isBullish ? lastPivotHigh - diff * 0.618 : lastPivotLow + diff * 0.618
fib786 = isBullish ? lastPivotHigh - diff * 0.786 : lastPivotLow + diff * 0.786

// ---- 4h trend confirmation (iteration 8) + zone width (iteration 10) ----
// Same pivot-based direction logic, computed independently on the 4h
// timeframe. A trade only fires when the 1h and 4h reads agree -- directly
// requested to cut noise further by requiring both timeframes to actually
// agree, not just the 1h swing in isolation. Also returns the 4h pivot
// high-to-low range as a support/resistance zone width (iteration 10) --
// a trade is skipped if that zone is narrower than minZoneWidth, on the
// theory that a tight 4h range signals an indecisive market rather than a
// real trending structure.
f_swingInfo(len) =>
    ph2 = ta.pivothigh(high, len, len)
    pl2 = ta.pivotlow(low, len, len)
    var float lastPH2    = na
    var float lastPL2    = na
    var int   lastPH2Bar = na
    var int   lastPL2Bar = na
    if not na(ph2)
        lastPH2    := ph2
        lastPH2Bar := bar_index - len
    if not na(pl2)
        lastPL2    := pl2
        lastPL2Bar := bar_index - len
    dir = (na(lastPH2) or na(lastPL2)) ? 0 : (lastPH2Bar > lastPL2Bar ? 1 : (lastPL2Bar > lastPH2Bar ? -1 : 0))
    zoneWidth = (na(lastPH2) or na(lastPL2)) ? na : (lastPH2 - lastPL2)
    [dir, zoneWidth]

[trend4h, zoneWidth4h] = request.security(syminfo.tickerid, "240", f_swingInfo(pivotLeftRight), lookahead = barmerge.lookahead_off)

// ---- 4h candle wick ratio at entry (iteration 15) ----
// Diagnostic finding: on the live 74-trade iteration-14 sample, winners'
// 4h candle (the one containing the entry) had a materially bigger wick
// relative to its range than losers' (avg 0.635 vs 0.549) -- a big 4h
// wick suggests real rejection/exhaustion at this level, consistent with
// a genuine reversal; a "clean" low-wick 4h candle suggests strong
// continuation momentum fighting this counter-trend Fib entry.
[o4h, h4h, l4h, c4h] = request.security(syminfo.tickerid, "240", [open, high, low, close], lookahead = barmerge.lookahead_off)
wick4hRange = h4h - l4h
wick4hRatio = wick4hRange != 0 ? 1 - math.abs(c4h - o4h) / wick4hRange : 0
validWick4h = wick4hRatio >= minWick4hRatio

validZone4h = not na(zoneWidth4h) and zoneWidth4h >= minZoneWidth

// EMA/VWAP confluence was tried here (iteration 9) and reverted -- it made
// win rate and profit factor much worse (see Backtest results). Requiring
// price above VWAP and EMA9>EMA21 for a long directly contradicts buying a
// Fib pullback, which by definition means price already dropped below
// recent structure.

// ---- Session filter (iteration 11) ----
// Found by diagnostic logging (not theorized) across all 164 of iteration
// 10's trade signals: night-session trades (20:00-06:00 UTC) were
// profitable (+$82.5) while day-session trades (07:00-19:00 UTC)
// accounted for essentially the entire loss (-$534.0) -- see Backtest
// results. First filter in this strategy's history to flip the whole
// backtest profitable.
barHourUTC  = hour(time, "UTC")
inNightSess = barHourUTC >= sessionStartHour or barHourUTC <= sessionEndHour

isBullishConfirmed = isBullish and trend4h == 1 and validZone4h and inNightSess and validWick4h
isBearishConfirmed = isBearish and trend4h == -1 and validZone4h and inNightSess and validWick4h

// ---- Position state ----
var float stopPrice = na

// ---- Risk-based position sizing (iteration 6, simplified in iteration 12) ----
// Since the stop now always costs exactly 100% of margin by construction,
// "risk % of equity" collapses to simply allocating that % of equity as
// margin directly.
f_marginForRisk(riskPct) =>
    strategy.equity * riskPct / 100

// ---- Entries: reversal-based, plus the liquidation-point stop (iteration 12) ----
// Gated on the *confirmed* (1h+4h agreeing) signals (iteration 8); fib
// levels themselves still come from the 1h swing computed above.
// 61.8% dropped (iteration 13) and 38.2% dropped (iteration 14): diagnostic
// found both were the only levels with a profit factor below 1, on two
// different trade samples (61.8%: 10.5% WR, PF 0.322, -$265.03; 38.2%:
// 17.9% WR, PF 0.389, -$79.58), while 50.0% and 78.6% stayed net positive.
// Only those two levels remain tradeable now.
if isBullishConfirmed
    float entryRiskPct = na
    if low <= fib786
        entryRiskPct := riskPct786
    else if low <= fib618
        entryRiskPct := na
    else if low <= fib500
        entryRiskPct := riskPct500
    else if low <= fib382
        entryRiskPct := na
    if not na(entryRiskPct)
        margin = f_marginForRisk(entryRiskPct)
        qty = (margin * leverage) / close
        strategy.entry("Long", strategy.long, qty = qty)
        stopPrice := close * (1 - liqLossFrac)
else if isBearishConfirmed
    float entryRiskPct = na
    if high >= fib786
        entryRiskPct := riskPct786
    else if high >= fib618
        entryRiskPct := na
    else if high >= fib500
        entryRiskPct := riskPct500
    else if high >= fib382
        entryRiskPct := na
    if not na(entryRiskPct)
        margin = f_marginForRisk(entryRiskPct)
        qty = (margin * leverage) / close
        strategy.entry("Short", strategy.short, qty = qty)
        stopPrice := close * (1 + liqLossFrac)

// ---- Exits: liquidation-point stop only -- wins still ride until the opposite signal ----
if strategy.position_size > 0
    strategy.exit("SL-L", from_entry = "Long", stop = stopPrice)
else if strategy.position_size < 0
    strategy.exit("SL-S", from_entry = "Short", stop = stopPrice)

plot(fib382, "Fib 38.2%", color = color.yellow)
plot(fib500, "Fib 50%", color = color.orange)
plot(fib618, "Fib 61.8%", color = color.red)
plot(fib786, "Fib 78.6%", color = color.maroon)
plot(lastPivotHigh, "Swing High", color = color.green)
plot(lastPivotLow, "Swing Low", color = color.blue)
```

## Backtest notes

- Run on the **1h chart**, BTCUSDT.P, on TradingView's Strategy Tester.
- **Since iteration 5, a flat -1% stop exists**, but Pine still doesn't
  simulate real exchange liquidation — at 100x, liquidation sits roughly 1%
  from entry too (before fees, the usual `1/leverage` approximation), so
  the coded stop and the real liquidation point are close enough together
  that fees/slippage/funding could still mean the exchange gets there
  first in reality. Treat backtest numbers as directionally informative,
  not as a guaranteed real-account outcome.
- Position size (qty) is risk-based since iteration 6 (a % of current
  equity, not a fixed dollar table), so dollar P&L now compounds with
  account size — expect the numbers to look different in scale from
  iterations 1-4, that's the sizing model doing its job, not a bug.
- The pivot-based swing (iteration 4) only updates when a NEW pivot is
  confirmed — a real improvement over iterations 1-3's every-bar window
  shift, but it means the levels can go a long time without updating during
  a strongly one-directional move (no opposing pivot forms), and there's a
  `pivotLeftRight`-bar delay before a new pivot is recognized at all. Worth
  watching on the chart to confirm the plotted swing high/low actually track
  real turning points, not stale ones.

## Backtest results (iteration 4, live-verified)

**First pass had a real bug**: the trend-direction comparison was ported
from iteration 1-3's `ta.highestbars`/`ta.lowestbars` ("bars ago" — larger
means OLDER) without flipping direction for `bar_index` (an absolute index
— larger means MORE RECENT). Result: `isBullish` stayed true continuously
through an 8-month real BTCUSDT decline (Jan–Sep 2026, ~93k→~80k) because
pivot lows kept being the most recently confirmed point, which the buggy
comparison read as "bullish" — the strategy spent the whole test trying to
buy dips in a bear market, went completely flat after Jan 9 (only 8 trades
total), PF 0.04.

**Fixed comparison, same date range:**

| Metric | Value |
|---|---|
| Total PnL | -$1,073.66 (-107.37%) |
| Win rate | **58.46% (38/65)** |
| Profit factor | 0.747 |
| Avg win | +$83.54 |
| Avg loss | -$132.79 |
| Biggest loss | **-$1,538.33 (-7.69%)** |

Genuinely good entry logic this time — win rate jumped to 58%, and the
equity curve climbed to roughly +$1,600 before collapsing. **One single
trade** (-$1,538.33 — held without any stop through a large adverse move,
since this version still has zero risk management) erased most of the
accumulated gains and pushed the total net negative. This is the clearest
evidence yet in this strategy's history that the entry logic itself has
real edge — the failure mode is entirely "no stop loss at 100x leverage
lets one bad hold destroy everything," not bad entries.

**Iterations 5-6 (flat -1% stop + risk-based sizing), same date range:**
motivated by web research into how high-leverage crypto scalpers actually
manage risk — search terms and specifics below.

| Metric | Value |
|---|---|
| Total PnL | -$791.96 (-79.20%) |
| Win rate | 46.33% (322/695) |
| Profit factor | 0.705 |
| Max drawdown | 82.83% |

Research findings that drove this: real scalpers size positions so a full
stop-out costs only 0.25-0.5% of equity, using *effective* leverage of
5-10x "not the maximum the platform allows" — the exchange's 100x ceiling
and your actual risk are different things ([KuCoin risk management
guide](https://www.kucoin.com/blog/crypto-futures-risk-management-2026)).
Standard position-sizing formula: decide risk % and stop distance first,
then size the position to fit — `margin = (equity × risk%) / (leverage ×
stopDistance%)` — leverage only changes margin required, not how much
should be risked ([Kraken position sizing
guide](https://www.kraken.com/tw/learn/futures-trading-position-sizing-leverage),
[BloFin position sizing
guide](https://blofin.com/en/academy/education/position-sizing-in-crypto)).
Both implemented directly: total return and drawdown both improved
substantially over iteration 4, but **trade count exploded from 65 to
695** — the pivot detector whipsaws during choppy stretches, each tiny
swing producing its own tiny, immediately-touchable Fib levels, and once a
stop let positions close quickly (instead of only ever waiting for a slow
opposite-signal reversal) that whipsaw could re-enter and re-exit rapidly.
The user caught this directly from the pile of near-breakeven trades.

**Iterations 7-8 (minimum swing size + 4h trend confirmation), same date
range:**

| Metric | Value |
|---|---|
| Total PnL | -$500.20 (-50.02%) |
| Win rate | 34.90% (67/192) |
| Profit factor | 0.729 |
| Max drawdown | 56.78% |
| Avg win / avg loss | +$20.08 / -$14.77 (~1.36:1) |

Trade count fell from 695 to 192 — both filters doing real work. Total
return and drawdown both improved again. The payoff ratio is now genuinely
favorable (~1.36:1, needs only ~42% win rate to break even) but win rate
sits at 34.90% — closer than any prior version, still short. Research also
flagged that real short-term crypto setups typically use **confluence**
(Fibonacci + VWAP + EMA together, not Fibonacci alone) and operate on much
faster 1-5 minute charts with 0.25-0.5% targets ([Cryptowisser Fib/VWAP/EMA
confluence
guide](https://www.cryptowisser.com/guides/fibonacci-vwap-ema-crypto-scalping/),
[Mudrex scalping
strategies](https://mudrex.com/learn/crypto-futures-scalping-strategies/))
— neither has been tried yet; see Next steps.

**Iteration 9 (EMA/VWAP confluence, attempted and reverted), same date
range:**

| Metric | Value |
|---|---|
| Total PnL | -$262.30 (-26.23%) |
| Win rate | **17.65% (9/51)** |
| Profit factor | **0.272** |
| Max drawdown | 26.23% |

Requiring EMA(9)>EMA(21) and close above VWAP for a long (mirror for
short) cut trade count sharply (192→51) but win rate and profit factor
both collapsed. Total dollar loss looks smaller only because far fewer,
much smaller trades were taken — this is not an improvement, it's the
filter rejecting most of the setups that used to work. **Reverted** — see
Entry logic and Status for the likely mechanism (the filter contradicts
buying a pullback by construction).

**Iteration 10 (minimum 4h zone width), same date range, built on
iteration 8 (not 9):**

| Metric | Value |
|---|---|
| Total PnL | -$451.37 (-45.14%) |
| Win rate | 30.06% (49/163) |
| Profit factor | 0.723 |
| Max drawdown | 54.02% |
| Avg win / avg loss | +$24.06 / -$14.31 (~1.68:1) |

A lateral move, not a clear improvement: trade count fell further
(192→163), total return and drawdown both improved slightly, and the
payoff ratio actually got better (~1.68:1, best of any iteration so far) —
but win rate fell to 30.06%, landing about the same distance from its
now-higher breakeven point (~37.3%) as iteration 8 was from its own
(~42%). Worth keeping as a real, if modest, refinement, but not the
win-rate breakthrough iteration 9 was meant to be (and wasn't).

**Diagnostic pass on iteration 10 (164 signals) — same technique that found
`short-term-high-risk`'s session filter**: added temporary `log.info()`
capturing hour, day-of-week, 4h ADX, 4h zone width, volume ratio, and which
Fib level triggered each entry; cross-referenced against actual outcome.

- **ADX and 4h zone width**: no separation between winners and losers —
  stated plainly as a null result, same as it was for `short-term-high-risk`.
- **Fib level**: 38.2% ran a 40.0% win rate (14/35); 61.8% ran only 16.7%
  (5/30) — a real, not-yet-acted-on pattern (61.8% is currently sized as a
  *larger* risk allocation despite being the weakest level).
- **Session — the standout finding**: night (20:00-06:00 UTC) ran +$82.5
  total on the 164 signals; day (07:00-19:00 UTC) ran -$534.0 — day-session
  trades accounted for essentially the entire loss. Note this is the
  *opposite* session from `short-term-high-risk`'s finding; different
  symbol/timeframe/mechanism, not a contradiction.

**Iteration 11 (night-session-only filter, 20:00-06:00 UTC), same date
range:**

| Metric | Value |
|---|---|
| Total PnL | **+$102.36 (+10.24%)** |
| Win rate | 23.23% (23/99) |
| Profit factor | **1.06** |
| Max drawdown | 29.37% |
| Avg win / avg loss | +$62.10 / -$18.27 (~3.4:1) |

**The first profitable configuration in this strategy's entire history.**
Win rate is the lowest of any iteration, but the payoff ratio (~3.4:1) more
than compensates — breakeven at that ratio is ~22.7%, and 23.23% clears it.
Real, live-verified, but a thin margin on one BTCUSDT window (Jan-Sep
2026) — not yet re-verified on a different range or symbol, and small
enough that normal sample variance could erase it.

**Iteration 12 (stop redefined as `1/leverage` instead of an independent
`maxLossPct`), same date range:**

| Metric | Value |
|---|---|
| Total PnL | **+$101.77 (+10.18%)** |
| Win rate | 23.23% (23/99) |
| Profit factor | **1.06** |
| Max drawdown | 29.37% |

Mathematically equivalent to iteration 11 at leverage=100 (`1/100 = 1.0%`,
the exact value `maxLossPct` was already hardcoded to) — the sub-$1
difference is rounding noise, not a behavior change. Confirms the refactor
is correct. The real benefit isn't this run's numbers, it's that the stop
now automatically tracks leverage: if leverage is ever changed from 100x,
the stop distance changes with it instead of silently drifting out of sync
with what "full liquidation" actually means at the new leverage.

**Iteration 13 (61.8% Fib level dropped entirely), same date range:**

Diagnostic re-run against the current 99-trade sample, broken out by level
(closed trades only):

| Level | Trades | Win rate | Profit factor | Total PnL |
|---|---|---|---|---|
| 38.2% | 25 | 20.0% (5/25) | 0.401 | -$64.59 |
| 50.0% | 13 | 38.5% (5/13) | **2.498** | +$153.53 |
| 61.8% | 19 | **10.5% (2/19)** | **0.322** | **-$265.03** |
| 78.6% | 42 | 26.2% (11/42) | 1.330 | +$259.32 |

61.8% is the only level with a profit factor below 1 by a wide margin, and
the pattern held up (in fact worsened) from iteration 10's earlier read on
a different, larger sample (16.7% WR pre-session-filter → 10.5% WR
post-filter) — confirming this is a durable weakness in that level, not
sample noise. Dropped it entirely rather than resizing it, per the method
described in Entry logic item 11:

| Metric | Value |
|---|---|
| Total PnL | **+$194.89 (+19.49%)** |
| Win rate | 24.47% (23/94) |
| Profit factor | **1.136** |
| Max drawdown | 26.77% |

**Best result in this strategy's history so far**, and by a wide margin —
total PnL nearly doubled (+$101.77 → +$194.89) from removing a single Fib
level, with a better profit factor and better drawdown too. Trade count
dropped from 99 to 94, consistent with removing ~19 signals but gaining
back a few trades that no longer get preempted by a since-removed 61.8%
reversal. Diagnostic methodology: same technique as iteration 10 (temporary
`log.info()` per entry, this time tagging the triggering Fib level, scraped
from TradingView's Pine Logs panel and joined against the List of Trades
by computed fill-time — signal bar + 1h, confirmed empirically again this
run); 100/100 log entries matched to trades with zero discrepancies, and
the per-level totals reconciled exactly against the dashboard's aggregate
stats (23/99 wins, PF 1.06) before the change was made.

**Iteration 14 (38.2% Fib level also dropped), same date range:**

Re-ran the same diagnostic against the fresh 94-trade sample iteration 13
created (removing 61.8% changes trade sequencing, so the old 99-trade
per-level numbers no longer applied):

| Level | Trades | Win rate | Profit factor | Total PnL |
|---|---|---|---|---|
| 38.2% | 28 | **17.9% (5/28)** | **0.389** | **-$79.58** |
| 50.0% | 17 | 35.3% (6/17) | 2.257 | +$185.00 |
| 78.6% | 49 | 24.5% (12/49) | 1.069 | +$69.21 |

38.2% was already the second-weakest level in iteration 13's read (20.0%
WR, PF 0.401, -$64.59) and got worse on this fresh sample — a real,
worsening pattern across two different samples, not noise. Dropped it
entirely, same treatment as 61.8%:

| Metric | Value |
|---|---|
| Total PnL | **+$232.02 (+23.20%)** |
| Win rate | 25.68% (19/74) |
| Profit factor | **1.18** |
| Max drawdown | 27.92% |

Another real improvement — total PnL up again (+$194.89 → +$232.02), PF up
(1.136 → 1.18) — though trade count dropped sharply (94 → 74, since only
two Fib levels can trigger an entry now) and drawdown ticked up slightly
(26.77% → 27.92%), worth watching if this pattern continues: each level
drop concentrates risk into fewer, larger trades. Only 50.0% and 78.6%
remain tradeable. 95/95 diagnostic log entries matched to trades with zero
discrepancies.

**Iteration 15 (4h candle wick-ratio entry filter), same date range:**

User-requested diagnostic, different in kind from the level-dropping
diagnostics above: rather than checking which Fib level triggered, this
one fetched real 15m and real 4h candles directly from Binance around all
74 of iteration 14's real trades and compared context *around the entry*
between winners and losers. Several 15m/4h features were checked
(15m RSI, 15m ATR%, 15m wick ratios over the preceding few candles, 4h
RSI, 4h candle wick ratio, distance to the nearest recent 4h swing
extreme) — full methodology and numbers below.

**15m RSI** showed a real, direction-independent pattern: in both LONG
trades (winners avg 36.9 vs losers 42.2) and SHORT trades (winners avg
53.9 vs losers 57.7), winners entered on a *more washed-out* 15m momentum
reading than losers, regardless of which direction was being traded —
intuitively consistent with a mean-reversion strategy (the deeper the
exhaustion, the better the reversal entry). Flagged as a real finding, not
yet acted on this iteration — see Next steps.

**4h candle wick ratio** (`1 - |close-open|/(high-low)` of the 4h candle
containing the entry) was the strongest single signal found: winners
averaged 0.635, losers 0.549. A threshold sweep on the same 74-trade
dataset (offline estimate, not yet the real Pine numbers):

| Threshold | Trades kept | Win rate | Profit factor | Total PnL |
|---|---|---|---|---|
| none (iteration 14) | 74 | 25.7% | 1.18 | +$232.0 |
| ≥0.5 | 45 | 31.1% | 1.663 | +$426.1 |
| ≥0.6 | 33 | 36.4% | 2.341 | +$555.9 |

**Distance to the nearest recent 4h swing extreme** showed a similar,
real-but-smaller effect (winners avg 2.50% away, losers avg 1.85%) —
entries closer to a recent 4h high/low did worse, plausibly because
there's less room for the reversal to develop and/or the level is more
likely to be retested/broken. Not acted on this iteration (see Next
steps) — the wick-ratio filter was the stronger, cleaner signal of the
two and iteration discipline says test one variable at a time.

Implemented the 4h wick-ratio filter and live-verified both thresholds
in Pine (the authoritative numbers, not the offline estimate above):

| Metric | Iteration 14 (no filter) | 0.5 threshold | 0.6 threshold |
|---|---|---|---|
| Total PnL | +$232.02 (+23.20%) | **+$617.22 (+61.72%)** | +$761.28 (+76.13%) |
| Win rate | 25.68% (19/74) | 28.57% (16/56) | 32.50% (13/40) |
| Profit factor | 1.18 | **1.602** | 2.051 |
| Max drawdown | 27.92% | **16.57%** | 15.47% |

Both thresholds are dramatic, genuine improvements over iteration 14 —
0.5 nearly triples total PnL while *also* improving drawdown by 11
points, not trading one for the other. 0.6 is stronger still on every
metric, but the trade count has now shrunk to 40 (from an original
~190+ signal pool, after three cumulative filters this session: two
Fib-level drops plus this wick filter) — small enough, and the 0.5→0.6
improvement large and close to linear enough, that it reads more like a
real risk of curve-fitting a shrinking sample than a plateauing genuine
effect. **Kept 0.5 deliberately** as the more conservative choice; **0.6
is recorded here to revisit later** if a proper out-of-sample check
(different date range/symbol — already the top item in Next steps)
still favors it once tested on data this filter wasn't tuned against.

Methodology: `apps/engine/src/scripts/_tmpLossPatternAnalysis.ts` (a
temporary, uncommitted script — not part of the repo) fetched 22,081 real
15m candles and 1,380 real 4h candles from Binance covering the full
trade history, joined them to all 74 trades by entry timestamp, computed
the features above per trade, and compared winner/loser distributions and
threshold sweeps. The Pine implementation and its live-verified numbers
are the authoritative result; the offline script was only used to decide
which threshold was worth testing in Pine, not trusted on its own.

## Engine port

This strategy's Pine script (iteration 14) was ported to a real TypeScript
`StrategyAlgorithm` in `apps/engine/src/strategy/btcHighRisk.ts`, so it can
actually run in `apps/engine` rather than only backtest on TradingView.
This is genuinely new capability, not just a doc update, so it's recorded
here rather than as another Pine iteration.

**Updated for iteration 15's wick filter.** `BtcHighRiskConfig` gained
`minWick4hRatio` (default 0.5, matching the Pine input default) and
`decide()` now computes the same 4h open/high/low/close wick-ratio check
described in iteration 15 above, gating `isBullishConfirmed`/
`isBearishConfirmed` exactly as the Pine script does. Ported after the
gap below was already known and unresolved — deliberately not re-verified
in isolation, since doing so on top of a still-open pivot-detector bug
would have been wasted effort; the pivot fix below and this filter should
be re-verified together in the next full parity check.

**Framework changes needed to support it** (this strategy's needs didn't
fit the engine's existing assumptions, built only for the always-in-100%
MA-cross demo):

- `StrategyAlgorithm.decide()` now returns `{ signal, riskFraction? }`
  instead of a bare signal — `riskFraction` lets an algorithm reserve only
  part of free capital as margin (this strategy sizes 1%/2% of equity per
  Fib level) instead of always spending everything on one trade.
  `StrategyRunner.enterPosition` now multiplies free capital by this
  fraction (defaulting to 1.0, unchanged, when an algorithm doesn't
  specify one) before reserving/sizing. `MovingAverageCrossStrategy` was
  updated to the new return shape with no behavior change.
- `StrategyAlgorithm.onAuxCandle?(tag, candle)` — an optional hook for a
  secondary timeframe's closed candles, since this strategy needs its own
  4h trend/zone confirmation (the Pine script's `request.security` call)
  alongside its primary 1h decisions. `index.ts` opens a second
  `BinanceFuturesKlineStream` (4h) and feeds it straight to this hook,
  bypassing `StrategyRunner` entirely since 4h candles never trigger an
  order on their own. `warmUpAuxCandles()` (new, alongside the existing
  `warmUpAlgorithm()`) primes it from history the same way.
- `apps/engine/src/marketData/binanceFuturesPublic.ts` and
  `binanceFuturesKlineStream.ts` — futures equivalents of the existing
  spot-only historical-fetch and WebSocket-stream helpers. Added as new
  files rather than parametrizing the spot ones, matching the
  additive-not-modifying convention Phase 3b already established for
  `BinanceFuturesBroker` alongside `BinanceBroker`. This matters here
  specifically: the existing engine-wide market data path is spot-only,
  but this strategy was researched and backtested against **BTCUSDT.P
  perpetual futures** prices — using spot data for a futures-calibrated,
  exact-price-level strategy would be a real (if usually small)
  data-source mismatch, not just a style preference.
- `StrategyRegistry`'s `RegisteredStrategy.stream` is now typed as a small
  structural `{ stop(): void }` interface instead of the concrete spot
  `BinanceKlineStream` class, and gained an optional `auxStreams` array —
  needed once a strategy can hold more than one live connection.

**A real, pre-existing bug found while wiring this up**: `apps/engine`'s
`npm run dev`/`start` scripts never actually loaded `.env` — no `dotenv`,
no `--env-file`, nothing. Every earlier phase's "verified live against
real credentials" claim in this document must have worked via some
IDE-specific auto-loading (a JetBrains run configuration, most likely),
not the documented `npm run dev` command itself, which would silently see
`undefined` for every credential and fall back to paper/no-op behavior
with no error. Fixed by adding Node's built-in
`--env-file-if-exists=../../.env` (Node 22, already this project's
version — `-if-exists` specifically so a fresh clone with no `.env` yet
doesn't crash on startup) to `dev`/`start`/`testnet-smoke`/
`futures-testnet-smoke` in both `apps/engine` and `apps/chatops`'s
`package.json`. Worth knowing if any earlier phase's "live-verified"
credential-dependent claim ever needs re-checking from a plain shell.

**Verified live** (not just typechecked): with that fix, `npm run dev`
warmed the algorithm up with 500 real 1h + 200 real 4h BTCUSDT.P futures
candles, then configured itself against the real Binance **futures
testnet** account (one-way position mode, ISOLATED margin, 100x) via
`BinanceFuturesBroker` — real signed API calls, all three succeeded with
no errors. Currently gated to testnet by two independent switches:
`BINANCE_FUTURES_USE_TESTNET` (shared convention, defaults true) and a
**strategy-specific** `BTC_HIGH_RISK_ALLOW_LIVE` (must be `"true"` even if
the first switch is flipped) — added specifically because of the
unresolved gap below, on top of (not instead of) the shared convention.

**Unresolved signal-parity gap — do not point this at a real account until
this is closed.** Cross-checked the ported algorithm's output against this
strategy's own real iteration-14 trade history (still cached from the
TradingView session, real trades from the live 20:00-06:00 UTC session
filter's actual backtest) for the same real calendar window
(2026-07-27 to 2026-08-31): fed 1000 real 1h + 300 real 4h BTCUSDT.P
futures candles (fetched fresh via `fetchHistoricalFuturesCandles`)
through the ported algorithm in strict chronological order (1h and 4h
candles merged and sorted by timestamp, so it never sees 4h context before
that candle actually closed) via a new standalone check,
`apps/engine/src/scripts/btcHighRiskSmokeTest.ts`. Result: of 8 real Pine
trades in that window, the port reproduced **3 exactly** (same direction,
same hour — Jul 30 Short, Aug 3 Short, Aug 27 Short), got **1 right on
direction but an hour off** (Aug 26 Long), and **missed the remaining 4
entirely**. The 3 exact matches are real evidence the core pivot/Fib/
session logic is fundamentally sound, not broken outright (the same
failure shape as the original Pine port's inverted bar-index bug would
look like zero or near-zero matches, not this) — but this is not
parity, and shipping a signal generator with a known, unexplained ~50%
miss rate to real capital would be irresponsible.

**Follow-up: re-ran the same check with a full-history warm-up.** Fetched
11,095 real 1h futures candles (from 2025-06-01) and 3,680 real 4h candles
(from 2025-01-01, well before the earliest real trade on 2026-01-12) —
matching, rather than truncating, the lead time Pine's own indicators had
before the backtest's visible date range starts. Result against all 94
real closed Pine trades: **45 exact matches, 15 more matching direction
within one hour, 34 missed entirely, and 0 direction mismatches whenever
the port fired near a real trade's time** — a match rate of 63.8%, up from
the ~41-day test's ~50%. The warm-up-length hypothesis was **partially
right**: a longer warm-up did meaningfully help. But a real, still-large
gap remains — 34 real trades the port never fires at all, and the port
also produced 148 total entries against 94 real ones, meaning a
substantial number of *extra* signals with no corresponding real trade.
Zero direction mismatches at matched times is a genuinely good sign (the
core Fib-level-to-direction mapping is not inverted or otherwise broken),
but this is still far from parity, and the extra-signal count in
particular points at something more specific than warm-up length — most
likely the pivot detector itself resolving a tie or near-tie differently
than Pine's `ta.pivothigh`/`ta.pivotlow` in some real, recurring set of
cases, compounding over an 8-month history into a meaningfully different
sequence of "current" swings. **Conclusion unchanged: not safe for real
capital.** The next concrete step is comparing the two pivot detectors
bar-by-bar on a shared slice of real data (log both the Pine and the
TypeScript port's `lastPivotHigh`/`lastPivotHighBar`/`lastPivotLow`/
`lastPivotLowBar` for the same real window and diff them directly) rather
than only comparing final trade outcomes, which conflates many small
per-bar disagreements into one hard-to-diagnose aggregate number.

**Root cause found and fixed: the pivot detector's tie-breaking rule.**
Rather than keep comparing final trade outcomes (which conflates many
small per-bar disagreements into one hard-to-diagnose aggregate number),
built an isolated synthetic test directly in the Pine Editor: a small
`indicator()` script feeding hand-crafted, deterministic source values
(via a `switch` on a locally-counted bar index, independent of any real
chart data) into the real built-in `ta.pivothigh`/`ta.pivotlow`, with
manufactured ties placed once on the left side of a candidate bar and once
on the right, plus a clean no-tie control. Result, decisively confirmed
across high, low, and both tie placements: **Pine's pivot functions break
ties asymmetrically** — a candidate tied by a bar to its right (a later,
more recent bar) is disqualified, but a tie against a bar to its left (an
earlier bar) does not disqualify it. In effect, the *last* bar in a run of
equal extremes wins the pivot, not every tied bar. `PivotSwingTracker`'s
original `update()` compared the whole rolling window non-strictly
(`<=`/`>=` against every bar), which let it confirm a pivot at *every*
tied bar in such a run — extra pivots Pine would never confirm, cascading
into different swings, Fib zones, and signals downstream. This is very
likely a real contributor to (though, since it was verified in isolation
rather than by re-running the full 94-trade check, not proven to fully
explain) both the 34-missed and especially the 88-extra-signal halves of
the 63.8% parity result above. Fixed in `PivotSwingTracker.update()`:
bars left of the candidate still allow ties, bars right of it now require
strict inequality. Typechecks, builds, and re-ran clean against real data
via `btcHighRiskSmokeTest.ts` (4 entries over the same ~41-day window,
non-zero and directionally sane — same shape as before the fix, as
expected since that quick check never had enough trades to show the
parity gap clearly in the first place).

**Re-verified with a full parity re-check — fix confirmed as a real,
substantial improvement, gap narrowed but not closed.** Re-ran real Pine
iteration-14 trades against the fixed port (`minWick4hRatio: 0` to
neutralize iteration 15's filter, isolating the pivot fix cleanly against
the iteration-14 baseline the original 63.8% number was measured
against). One methodology deviation, disclosed rather than glossed over:
the original 94-trade check's warm-up went back to 2025-06-01/2025-01-01,
but this TradingView account's 1h chart history for this symbol now only
reaches back to ~Jan 2026 (confirmed live — "Go to date" for both
2025-06-01 and 2025-11-01 clamps to the same earliest bar) — so this
re-check used a shorter, but identically-applied, warm-up window from
2026-01-01 for both Pine and the port. Not a byte-for-byte repeat of the
exact same run, but a fair test of the same question. Result, over
Jan 1-Sep 6, 2026: **73 real trades, 74 port entries, 54 exact matches, 10
off-by-one-hour, 9 missed entirely, 10 extra port-only signals, 0
direction mismatches — an 87.7% match rate, up from 63.8%.** Extra
port-only signals collapsed from 88 to 10, direct confirmation the
tie-breaking bug was generating spurious pivots essentially as
hypothesized. **Conclusion: the gap is narrowed, not closed.** 87.7% is a
real, large improvement — not noise — but still short of "genuinely close
to 100%," with 9 real trades still missed and 10 signals still extra.
`BTC_HIGH_RISK_ALLOW_LIVE` stays gated; a further diagnostic pass on the
remaining 9+10 divergent cases specifically (rather than another aggregate
re-run) is the next concrete step if this is worth continuing to chase.

**Other known gaps, flagged in code comments, not hidden**:

- The liquidation-tied stop is checked once per closed 1h candle against
  that candle's high/low, not continuously in real time — matches what the
  Pine backtest itself actually verified (same bar-granularity), but a
  live position sits unprotected between candle closes. A real deployment
  should place an actual exchange-side `reduceOnly` `STOP_MARKET` order
  right after entry so the exchange enforces it continuously; that order
  type doesn't exist in this codebase yet (`OrderType` is
  `"MARKET" | "LIMIT"` only in `packages/shared`) — a real follow-up, not
  built here.
- Position state (including the recorded stop price) is in-memory only,
  lost on a process restart — same documented limitation `StrategyRunner`
  itself already carries.
- The pivot detector (`PivotSwingTracker` in `btcHighRisk.ts`) now matches
  Pine's confirmed tie-breaking rule (see above), but still isn't a
  verified byte-for-byte match in every other respect — a fresh full parity
  re-check is still owed before treating it as equivalent to Pine's
  built-in `ta.pivothigh`/`ta.pivotlow`.

## Next steps

0. **Close the engine port's signal-parity gap** (see Engine port above)
   before this touches even futures testnet execution in earnest, let
   alone a real account. Already re-tested with a full-history warm-up
   (11,095 real 1h + 3,680 real 4h candles from well before the backtest's
   start) — improved the match rate from ~50% to 63.8% (45 exact + 15
   off-by-1h out of 94 real trades, 0 direction mismatches when matched),
   confirming warm-up length was part of the problem but not all of it: 34
   real trades still missed entirely, plus 88 extra port-only signals with
   no matching real trade. **Since then**: found and fixed one confirmed
   real bug behind this via an isolated synthetic Pine test (not just the
   trade-outcome comparison) — `PivotSwingTracker`'s tie-breaking didn't
   match Pine's actual (asymmetric) rule, letting the port confirm extra
   pivots Pine never would. **Re-verified**: 87.7% match rate post-fix (54
   exact + 10 off-by-1h out of 73 real trades, 10 extra port-only signals,
   down from 88) — a real, substantial improvement, confirming the
   hypothesis, but still not "close to 100%." 9 real trades missed and 10
   extra signals remain. Next concrete step: diagnose those specific
   remaining divergent cases directly (not another aggregate re-run) —
   only once that residual gap is closed too should
   `BTC_HIGH_RISK_ALLOW_LIVE` even be reconsidered.
1. **Re-verify on a different date range or symbol** before trusting this
   margin — now the single most urgent item by far. Iteration 15's +$617
   (56 trades) is nearly triple iteration 14's already-unverified +$232 (74
   trades), on the same one BTCUSDT window every iteration this session has
   been tuned against. A result this much better, found by testing several
   candidate features and picking the best one, is exactly the shape of
   result that most needs an out-of-sample check before being trusted.
2. **Revisit the 0.6 wick-ratio threshold** (currently 0.5) if the
   out-of-sample check above still favors it once tested on data this
   filter wasn't tuned against — live-verified at +$761.28, PF 2.051, DD
   15.47% on 40 trades, better than 0.5 on every metric, but not chosen
   initially given the shrinking sample (see iteration 15 in Backtest
   results for the full reasoning).
3. **Act on the 15m RSI finding** from iteration 15's diagnostic (winners
   consistently enter on more washed-out 15m momentum than losers, in both
   directions) — found but not yet acted on this iteration, since testing
   the wick-ratio filter first was the priority. A candidate filter (e.g.
   require 15m RSI beyond some distance from 50 in the retracement
   direction) is worth the same live-verification treatment.
4. **Watch for over-fitting from repeated filter-stacking**: two Fib
   levels are gone and a wick-ratio filter has been added, each
   individually justified by real diagnostic data, but the strategy is
   down to 56 trades from an original ~190+ signal pool. Each additional
   filter should be held to a higher bar of skepticism than the last, and
   out-of-sample validation (item 1) matters more with every one added.
5. Iteration 9 showed that naive trend-confluence (EMA/VWAP requiring price
   already past a breakout) actively fights the Fib pullback logic. Any
   future confluence attempt needs to check *momentum turning*, not just
   trend alignment — e.g. price reclaiming the fast EMA from below on the
   bounce, not already being above it.
6. Consider whether the 1h/4h timeframe pair is fundamentally mismatched
   with 100x leverage — real scalping research points to 1-5 minute charts
   with 0.25-0.5% targets, not multi-hour swing holds. Not tested this
   session.
7. Re-verify iteration 3's ADX-filter result under the now-fixed swing
   logic — it was tested against the buggy trend direction, so that result
   is no longer trustworthy either way.
8. Investigate the -3.95% biggest-loss outlier under the -1% stop (iteration
   8's List of Trades) — likely a real gap-through-the-stop case given 1h
   BTC candle size, not a bug, but worth a quick check before assuming so.
