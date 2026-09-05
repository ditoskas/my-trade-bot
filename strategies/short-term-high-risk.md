# Short-Term High-Risk

**Status:** draft, v3 is the current baseline — v1 (1.5× ATR trail), v2 (2.0×
ATR trail, reverted), and v3 (0.5× ATR stop buffer) have all been run on
BTCUSDT by the user; see **Backtest results** below for the real numbers. v3
improved PnL, profit factor, drawdown, and win rate all at once over v1 — the
best result so far. **Iteration 4 (an exit-order bug fix) was attempted,
live-tested, and reverted** — see Backtest results for the full story; the
bug is real but the fix needs more work before it's worth keeping, so v3's
exit logic is back in place below. Win rate (22.5%, 9/40) is still the user's
main open concern. Still not executed by Claude directly — a connected
Chrome tab was used to live-test iteration 4 on real TradingView, but v1-v3
results all came from the user running it themselves.

## Overview

A multi-timeframe (4h regime, 1h confirmation, 15m trigger) trend-continuation
breakout on Binance USDT-M perpetual futures, sized to target 100% profit on
margin via 10-20x leverage on a single short-term move. Deliberately
high-risk by design — the name is literal, not a euphemism. Bounded per-trade
loss (see Stop loss logic) is what keeps "high risk" from meaning "unbounded
risk."

**Symbol universe** (scanner, not a fixed pair): Binance USDT-M futures top-5
24h gainers + top-5 24h losers (by `priceChangePercent` from the public
`GET /fapi/v1/ticker/24hr` endpoint — no API key needed) plus a manually
maintained favorites list, currently **BTCUSDT, PENGUUSDT**. Binance's API
has no endpoint for reading a user's actual favorites/watchlist (confirmed by
search, not assumed) — it's a UI-only preference, so this list has to be
kept in sync by hand, here and in the eventual engine config.

**Important scope note**: the gainers/losers/favorites scanning logic is
described here for completeness, but it is **not, and cannot be, part of the
Pine backtest below**. "Today's top gainers" isn't a stable historical
dataset — there's no way to backtest "would this symbol have been in the top
5 on a given past date" in Pine at all. The Pine script instead validates the
entry/exit/stop/target *mechanics* against one representative symbol
(BTCUSDT). The actual cross-symbol scanning is engine-side (TypeScript) work
for whenever/if this gets promoted, not a Pine Script concern.

## Entry logic

Bidirectional — a confirmed bearish regime enables shorts, not just a bullish
regime enabling longs.

**Long:**
- **4h regime**: EMA(20) > EMA(50) **and** ADX(14) > 25 — confirms a real
  uptrend exists, not just noise.
- **1h confirmation**: 1h close above the 1h EMA(50) — a second filter so a
  4h signal that's already fading doesn't get taken.
- **15m trigger**: close breaks above the highest high of the prior 10 15m
  bars (Donchian-style breakout), **with** 15m volume > 1.5× its 20-bar
  average — favors genuine momentum ignition over a weak, low-conviction
  breakout.

**Short:** exact mirror — 4h EMA(20) < EMA(50) and ADX(14) > 25, 1h close
below 1h EMA(50), 15m closes below the lowest low of the prior 10 bars with
the same volume filter.

## Stop loss logic

**Structural, with an ATR buffer** (iteration 3 — see Backtest results): for
a long, the stop sits at the low of the same 10-bar range whose high
triggered entry, **minus 0.5× ATR(14, 15m)** (mirrored above the 10-bar high
plus the buffer for shorts). The buffer exists because v1/v2 placed the stop
*exactly* at the range boundary, which a perfectly normal post-breakout
retest can tag without the move actually failing — the buffer gives the
trade room to breathe through a retest before calling it invalidated.

**Safety cap on top of the buffered stop** — the cap check uses the *actual*
(buffered, wider) stop distance, not the raw structural level. Using the
narrower pre-buffer distance here would silently let more risk through than
the cap is supposed to permit. This is the part that actually
makes 10-20x leverage survivable: at 20x, liquidation sits roughly 5% away
from entry; at 10x, roughly 10% away (using the simple `1/leverage`
approximation — Pine can't query Binance's actual tiered maintenance-margin
brackets, so this is intentionally conservative, not exact). The maximum
allowed stop distance is capped at **50% of that liquidation distance**:
`0.5 / leverage` as a fraction of entry price (5% at 10x, 2.5% at 20x). **If
the structural stop is wider than this cap, the trade is skipped entirely** —
no entry — rather than take a setup whose invalidation point is effectively
"get liquidated anyway."

One clean consequence of this design: because the cap is defined as a fixed
fraction of the liquidation distance, **the maximum possible loss per trade
is always exactly 50% of the fixed margin (50 USDT of the 100 USDT per
trade), regardless of which leverage between 10x-20x is actually used** —
before fees/slippage.

## Take profit logic

Full target = 100% profit on margin, which requires the price itself to move
`100 / leverage`% (10% at 10x, 5% at 20x).

**Scale-out, not a single all-or-nothing exit:**
1. At **50% of the full target** (price move of `50 / leverage`%): close
   **50% of the position**, and **move the stop to breakeven** (the entry
   price) on the remainder. This was an explicit requirement, not just a
   design choice — once a trade is up more than 50%, it can no longer turn
   into a loss.
2. The remaining 50% of the position exits at either the full 100% target,
   or a **1.5× ATR(14, 15m) trailing stop** (reverted from 2.0× — iteration
   2 tested wider and it was slightly worse, not better; see Backtest
   results), whichever is reached first — letting a strong move run past
   100% if momentum continues, while locking in gains if it stalls.

**Known bug, not yet fixed** (iteration 4 investigation — see Backtest
results): the structural stop and the TP1 target are combined into one order
covering only 50% of the position, pre-TP1. If price hits the *stop* side of
that order instead of the TP1 side, the code can't tell the difference from
a same-size position shrink — it treats the stop-loss as if TP1 had been
reached, moves the remaining 50%'s stop to breakeven, and can leave it stuck
on the wrong side of an already-losing trade. Confirmed real via live
TradingView testing; three fix attempts were tried and reverted (each
introduced a worse problem or an unexplained edge case) — see Backtest
results for the full account. Living with this for now rather than shipping
an unverified fix.

## Exit rules

No time-based exit — runs until stopped out or the target is hit (including
the breakeven-move and trailing mechanics above). No other discretionary
exit conditions.

## Position sizing

- **Fixed 100 USDT margin per trade**, regardless of symbol or which
  leverage (10-20x) is in use. Notional exposure = margin × leverage (1,000
  - 2,000 USDT).
- **Only one position open at a time**, across the *entire* symbol universe
  (gainers + losers + favorites) — this is a hard constraint the user set
  explicitly. This is naturally already true within the Pine backtest itself
  (a single-symbol Pine strategy can only ever hold one position on its own
  chart), but it's a real open question for the eventual engine-side
  scanner: **what happens when multiple symbols qualify simultaneously?**
  No tie-breaking rule has been decided yet (strongest ADX? highest volume?
  first detected?) — flagged here rather than guessed at, since it doesn't
  affect the Pine backtest but will matter the moment this is promoted.

## Targets

- **Market regime**: deliberately only trades confirmed 4h trending
  conditions (ADX > 25) — sits out ranging/choppy markets entirely by
  design, since a 100%-target move needs genuine directional expansion, not
  routine chop.
- **Performance expectation**: none formally set — explicitly exploratory,
  high-risk/high-reward. The bounded max loss (50 USDT) against the
  unbounded-upside scale-out (100%+ per full-target trade) is the stated
  risk/reward shape; no target win rate or Sharpe ratio has been specified,
  and shouldn't be assumed.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Leverage | 10x | Adjustable 10-20x via input, but see the Pine `margin_long`/`margin_short` note below — those don't move automatically with this input. |
| Fixed margin per trade | 100 USDT | |
| 4h fast EMA | 20 | |
| 4h slow EMA | 50 | |
| 4h ADX length | 14 | |
| 4h ADX trend threshold | 25 | |
| 1h confirmation EMA | 50 | |
| 15m breakout lookback | 10 bars | |
| Volume filter multiplier | 1.5x | vs. 20-bar average volume |
| Stop-loss safety cap | 50% | fraction of the `1/leverage` liquidation-distance approximation |
| TP1 (partial exit + breakeven) | 50% of target | closes 50% of position |
| Trailing stop (post-TP1) | 1.5× ATR(14, 15m) | raised to 2.0x in iteration 2, tested worse, reverted — see Backtest results |
| Stop-loss ATR buffer | 0.5× ATR(14, 15m) | iteration 3 — added beyond the structural level so a normal post-breakout retest doesn't trigger a premature stop-out |
| Max concurrent positions | 1 | across the whole symbol universe |

## Pine Script v6

Multi-timeframe data is pulled via `request.security()` with
`lookahead=barmerge.lookahead_off` to avoid lookahead bias — this is the
standard safe pattern, though some repainting of the *currently forming*
higher-timeframe bar is a known, accepted limitation of MTF Pine scripts in
general, not something fully solvable without confirmed-bar-only techniques
that add significant complexity. Worth knowing about, not something this
script tries to eliminate entirely.

Entries are evaluated on bar close (Pine's default — no
`process_orders_on_close` override needed here). Stop-loss and take-profit
are implemented as native `strategy.exit()` bracket orders, which Pine fills
intrabar against the high/low of each bar — this is the *correct*, realistic
behavior for resting stop/limit orders (unlike entries, which should wait
for a confirmed close, a real stop-loss order on an exchange triggers the
instant price touches it, not at the next candle close).

```pinescript
//@version=6
strategy(
     "Short-Term High-Risk (MTF Breakout)",
     overlay=true,
     default_qty_type=strategy.fixed,
     default_qty_value=0,
     initial_capital=1000,
     currency=currency.USDT,
     // Simulates 10x leverage (100/10). This is a COMPILE-TIME CONSTANT —
     // Pine does not allow margin_long/margin_short to reference an input
     // variable. If you want to backtest at a different leverage than the
     // "leverage" input's default below, you must edit this literal value
     // too (100/leverage) — changing the input alone does not do this.
     margin_long = 10,
     margin_short = 10,
     commission_type = strategy.commission.percent,
     commission_value = 0.05)

// ---- Inputs ----
leverage         = input.float(10, "Leverage (see margin_long/short note above)", minval = 10, maxval = 20, step = 1)
fixedMarginUSDT  = input.float(100, "Fixed margin per trade (USDT)")
emaFastLen       = input.int(20, "4h fast EMA")
emaSlowLen       = input.int(50, "4h slow EMA")
adxLen           = input.int(14, "4h ADX length")
adxThreshold     = input.float(25, "4h ADX trend threshold")
ema1hLen         = input.int(50, "1h confirmation EMA")
breakoutLookback = input.int(10, "15m breakout lookback (bars)")
volMultiplier    = input.float(1.5, "Volume filter multiplier")
stopCapFraction  = input.float(0.5, "Stop-loss safety cap (fraction of 1/leverage)")
atrLen           = input.int(14, "ATR length (trailing stop)")
atrTrailMult     = input.float(1.5, "ATR multiplier (trailing stop)")  // reverted from 2.0 — iteration 2 tested worse, see Backtest results
atrStopBuffer    = input.float(0.5, "ATR buffer on structural stop")   // iteration 3

// ---- Higher-timeframe data ----
f_ema(len) => ta.ema(close, len)
f_adx(len) =>
    [_, _, adxVal] = ta.dmi(len, len)
    adxVal

ema20_4h = request.security(syminfo.tickerid, "240", f_ema(emaFastLen), lookahead = barmerge.lookahead_off)
ema50_4h = request.security(syminfo.tickerid, "240", f_ema(emaSlowLen), lookahead = barmerge.lookahead_off)
adx_4h   = request.security(syminfo.tickerid, "240", f_adx(adxLen), lookahead = barmerge.lookahead_off)
ema50_1h = request.security(syminfo.tickerid, "60", f_ema(ema1hLen), lookahead = barmerge.lookahead_off)
close_1h = request.security(syminfo.tickerid, "60", close, lookahead = barmerge.lookahead_off)

// ---- 15m trigger ----
donchianHigh = ta.highest(high[1], breakoutLookback)
donchianLow  = ta.lowest(low[1], breakoutLookback)
volSma20     = ta.sma(volume, 20)
volFilter    = volume > volSma20 * volMultiplier
atrVal       = ta.atr(atrLen)

bullRegime  = ema20_4h > ema50_4h and adx_4h > adxThreshold
bearRegime  = ema20_4h < ema50_4h and adx_4h > adxThreshold
bullConfirm = close_1h > ema50_1h
bearConfirm = close_1h < ema50_1h

longTrigger  = close > donchianHigh and volFilter
shortTrigger = close < donchianLow  and volFilter

longSetup  = bullRegime and bullConfirm and longTrigger
shortSetup = bearRegime and bearConfirm and shortTrigger

// ---- Buffered structural stop levels (iteration 3) ----
// Computed once here and reused both for the safety-cap check below and the
// entry block's stopPrice assignment, so the cap always sees the actual
// (wider) stop distance rather than the narrower pre-buffer level.
longStopLevel  = donchianLow  - atrStopBuffer * atrVal
shortStopLevel = donchianHigh + atrStopBuffer * atrVal

// ---- Safety cap ----
maxStopFraction  = stopCapFraction / leverage
longStopDistPct  = (close - longStopLevel) / close
shortStopDistPct = (shortStopLevel - close) / close
longAllowed      = longStopDistPct  <= maxStopFraction
shortAllowed     = shortStopDistPct <= maxStopFraction

// Fixed margin * leverage / price = base-asset quantity
posQty = (fixedMarginUSDT * leverage) / close

// ---- Position state ----
var float entryPrice = na
var float stopPrice  = na
var float tp1Price   = na
var float tp2Price   = na
var bool  tp1Done     = false

// ---- Entries — only one position at a time ----
if strategy.position_size == 0
    if longSetup and longAllowed
        strategy.entry("Long", strategy.long, qty = posQty)
        entryPrice := close
        stopPrice  := longStopLevel
        tp1Price   := close * (1 + 0.5 / leverage)
        tp2Price   := close * (1 + 1.0 / leverage)
        tp1Done    := false
    else if shortSetup and shortAllowed
        strategy.entry("Short", strategy.short, qty = posQty)
        entryPrice := close
        stopPrice  := shortStopLevel
        tp1Price   := close * (1 - 0.5 / leverage)
        tp2Price   := close * (1 - 1.0 / leverage)
        tp1Done    := false

// ---- Detect TP1 fill (position shrank but isn't flat) and move stop to breakeven ----
if strategy.position_size != 0 and not tp1Done
    // strategy.exit's own qty_percent fill is what actually reduces size;
    // this flag just tracks that it happened so the second exit call below
    // switches from "structural stop" to "breakeven + trailing". Known gap
    // (iteration 4 investigation, reverted — see Backtest results): this
    // can't distinguish a real TP1 fill from the bracket order's OWN stop
    // leg firing on just this 50%, which can misfire the breakeven move.
    // Confirmed real via live testing; not yet fixed in a way that's
    // actually verified to be better than living with it.
    if math.abs(strategy.position_size) < math.abs(posQty) * 0.99
        stopPrice := entryPrice
        tp1Done   := true

// ---- Exits: bracket order before TP1, breakeven+trailing runner after ----
if strategy.position_size > 0
    if not tp1Done
        strategy.exit("Bracket-L", from_entry = "Long", qty_percent = 50, limit = tp1Price, stop = stopPrice)
    else
        trailStop = math.max(stopPrice, close - atrVal * atrTrailMult)
        strategy.exit("Runner-L", from_entry = "Long", limit = tp2Price, stop = trailStop)
else if strategy.position_size < 0
    if not tp1Done
        strategy.exit("Bracket-S", from_entry = "Short", qty_percent = 50, limit = tp1Price, stop = stopPrice)
    else
        trailStop = math.min(stopPrice, close + atrVal * atrTrailMult)
        strategy.exit("Runner-S", from_entry = "Short", limit = tp2Price, stop = trailStop)

plot(ema20_4h, "4h EMA20", color = color.blue)
plot(ema50_4h, "4h EMA50", color = color.orange)
plot(donchianHigh, "10-bar High", color = color.green)
plot(donchianLow, "10-bar Low", color = color.red)
```

## Backtest results

**v1 (1.5× ATR trailing stop), 15m chart, Jul 1 - Sep 5 2026, $1,000 initial
capital:**

| Symbol | Total PnL | Max drawdown | Win rate | Profit factor |
|---|---|---|---|---|
| PENGUUSDT | -196.26 USDT (-19.63%) | 274.58 USDT (27.46%) | 20.00% (12/60) | 0.562 |
| BTCUSDT | +15.15 USDT (+1.52%) | 89.07 USDT (8.91%) | 19.57% (9/46) | 1.085 |

Confirmed on-chart: the TP1/breakeven/runner scale-out mechanism does fire
as two distinct labeled exits ("Bracket-S"/"Runner-S" etc.) — the fill
detection logic is working, not silently broken.

**What the comparison actually shows**: win rate is nearly identical across
both symbols (~20%), so win rate was not the differentiator. Decomposing
profit factor into average win/loss size: PENGU's avg loss (~9.3 USDT) is
roughly double BTC's (~4.8 USDT) for the same % stop-cap logic, while avg
win size is similar on both (~21 USDT) — giving BTC a much better payoff
ratio (~4.5:1 vs PENGU's ~2.25:1). BTC's breakeven win rate at that payoff
ratio is ~18%, so its actual 19.57% just barely clears it — **+1.52% here is
not a validated edge, it's barely above breakeven**, and doesn't yet account
for realistic slippage beyond the flat 0.05% commission modeled.

**Conclusion driving iteration 2**: a ~20% win rate is characteristic of
this style of strategy (trend-continuation/breakout systems commonly run
20-40% win rates by design, profiting from a few large winners) — chasing a
*higher win rate* directly risks cutting into the payoff ratio that's the
only thing keeping BTC positive at all. The more promising lever is
extending the payoff ratio further: raising the trailing-stop multiplier
from 1.5x to 2.0x ATR, on the hypothesis that winners are being cut short
before reaching their real potential. That's the only change in iteration 2
— everything else is held constant so the comparison stays clean.

**v2 (2.0× ATR trailing stop), BTCUSDT, same date range:**

| Symbol | Total PnL | Max drawdown | Win rate | Profit factor |
|---|---|---|---|---|
| BTCUSDT | +12.43 USDT (+1.24%) | 8.95% | 19.57% (9/46) | 1.069 |

**Hypothesis not confirmed.** Trade count and win rate are identical to v1
(9/46 = 19.57%) — as expected, since the trailing multiplier only affects
*where* the runner exits, not whether entries/TP1 fire. But PnL and profit
factor both came back slightly *worse* than v1 (+12.43 vs +15.15 USDT; 1.069
vs 1.085 PF). Widening the trail gave losing/breakeven-ish runners more room
to round-trip back down before stopping out, without capturing enough extra
upside on the winners to compensate. The lever that looked promising in
theory (let winners run further) didn't pay off in practice — worth stating
plainly rather than rationalizing a marginal-looking negative result as
"basically the same."

**Iteration 3 rationale**: since the trailing-stop lever didn't help, go back
to the other candidate identified in the v1 analysis — average loss size.
PENGU's avg loss was roughly double BTC's for the same % stop-cap logic, and
one plausible mechanism is that the stop sits *exactly* on the structural
level (the Donchian boundary), so an ordinary post-breakout retest can tag it
and stop the trade out even when the underlying move is still intact. Adding
a 0.5× ATR buffer beyond that level gives the trade room to survive a normal
retest, which should show up as fewer stop-outs on trades that would
otherwise have gone on to hit TP1/target — i.e. a higher win rate and/or
smaller average loss, not a change to the trailing-stop behavior at all.
This is a single-variable change from v1 (trailing multiplier is reverted to
1.5x, holding that constant) so it can be compared cleanly against the v1
baseline above rather than v2.

**v3 (0.5× ATR stop buffer, trailing multiplier back to 1.5×), BTCUSDT, same
date range:**

| Symbol | Total PnL | Max drawdown | Win rate | Profit factor |
|---|---|---|---|---|
| BTCUSDT | +24.70 USDT (+2.47%) | 86.31 USDT (8.63%) | 22.50% (9/40) | 1.146 |

**Hypothesis confirmed, and by more than expected.** Every headline metric
improved over v1 at once: PnL nearly doubled (+24.70 vs +15.15 USDT), profit
factor rose (1.146 vs 1.085), drawdown fell slightly (8.63% vs 8.91%), and
win rate rose too (22.50% vs 19.57%) — despite the number of winning trades
staying exactly the same (9). The mechanism: total trade count dropped from
46 to 40. The buffer widens the *actual* stop distance used in the safety-cap
check (by design — see Stop loss logic), so some setups whose raw structural
stop was already close to the cap now get pushed over it by the added buffer
and are skipped entirely rather than entered. All 6 filtered-out trades were
apparently losers (win count unchanged, loss count fell by 6) — consistent
with the theory that tight-structural-stop setups were disproportionately the
ones getting stopped out on normal noise/retests, not genuine failures.

**Caveat**: n=40 is still a small sample — a handful of trades either way
would move win rate and PF noticeably. Treat "confirmed" here as "the
direction and magnitude are what the hypothesis predicted," not as
statistically airtight. Re-testing on PENGUUSDT and other symbols before
locking this in is still the right next step, not skipped, just not done in
this iteration.

**Iteration 4 investigation (attempted, reverted) — the TP1-misdetection bug**:
diagnosed a real bug directly from v3's List of Trades data (not guessed):
the pre-TP1 exit order combines the TP1 limit and structural stop into ONE
order covering only 50% of the position. If the *stop* side fires instead of
TP1, the code can't tell the difference from a same-size shrink — it treats
the stop-loss as if TP1 had been reached, moves the remaining 50%'s stop to
breakeven, and leaves it on the wrong side of an already-losing trade.
Confirmed against real trade pairs: 1/2 and 3/4 (Jul 1, Jul 3) both show two
losses 15 minutes to a few hours apart from one signal — the classic
signature. This session had **live TradingView access** (a connected Chrome
tab, not just user-reported screenshots) and used it to test three fix
attempts in place, each surfacing a new Pine order-management subtlety:

1. Split into two orders (TP1 `qty_percent=50`, stop with no qty specified,
   assuming unspecified meant "100% of whatever remains"). **Wrong** — Pine
   allocates an unspecified qty as the *complement* of sibling orders'
   explicit percentages, so the "stop" order only covered the other 50%.
   Live result: a position sat open and unprotected for two months with a
   -18.86%-of-equity floating loss — worse than the original bug.
2. Made both halves explicit `qty_percent=50` (fixing the allocation), but
   stopped resubmitting the stop-only order once `tp1Done` flipped, switching
   to a differently-named runner order instead. **Wrong** — a Pine exit order
   that stops being resubmitted doesn't cancel, it stays resting at its last
   parameters, so the abandoned order kept "owning" its 50% share forever.
   Live result: a winning runner never trailed and sat open through a
   2-month rally instead of taking profit or trailing out.
3. One persistent stop-side order, called every bar for the trade's whole
   life with an explicit `qty_percent=50` in both phases. This fixed both
   prior failures for the common case — three of four re-tested signal pairs
   (Jul 1, Jul 3, Jul 21) now closed as clean simultaneous 100% stop-outs,
   exactly as intended. But one pair (Jul 6 entry) still split asymmetrically
   — one leg stopped at a loss on Jul 7 while the other rode a real TP1 win to
   Jul 21 — with no confirmed explanation for why two orders nominally
   sharing the same stop level didn't fire together that time. A cosmetic
   rounding artifact also showed up (a 0.000001 BTC "dust" position left
   permanently open, ~$0.07, economically negligible).

**Result with attempt 3 in place**: -14.98 USDT (-1.50%), 4.43% drawdown,
12.5% win rate (1/8), PF 0.62 — worse than v3's baseline. Part of that is a
real, non-bug side effect of fixing the bug correctly: letting winners run
(as the strategy's own rules intend) ties up the single open-position slot
for weeks at a time, blocking every other signal in that window — a real
behavior change, not obviously comparable to v3 on this small a sample. But
with one unexplained asymmetric case still present, the fix isn't verified
enough to trust yet. **Decision: reverted to v3's exit code** (the version
above, restored) rather than ship an uncertain fix with worse measured
results and one open discrepancy. The bug is real and documented in the
Pine script's comments; a cleaner redesign (a single always-active stop order
with `strategy.close()` handling TP1 explicitly, avoiding Pine's multi-order
qty-allocation ambiguity entirely) is the leading candidate for a future
attempt, not started here.

**Not yet tested**: iteration 3 on PENGUUSDT or other symbols; whether
PENGU's larger average-loss gap is really a liquidity/execution effect or
something else; a higher, more realistic commission/slippage assumption to
pressure-test whether BTC's edge survives real costs.

## Backtest notes

- Run on the **15m chart**, BTCUSDT perpetual futures, on TradingView's
  Strategy Tester.
- **Verify the TP1 → breakeven → trailing transition manually** on at least
  a handful of individual trades in the trade list. The fill-detection logic
  (`strategy.position_size` shrinking below 99% of the original quantity)
  is the part most likely to have an off-by-something issue — confirm it
  actually flips `tp1Done` at the right moment rather than trusting the
  aggregate stats.
- The `margin_long`/`margin_short = 10` literal only simulates 10x. To
  actually test 20x behavior (not just the 20x-adjusted TP/SL math), change
  that literal to `5` as well as the `leverage` input.
- The 1/leverage liquidation-distance approximation ignores Binance's real
  tiered maintenance-margin brackets, which get worse (more conservative)
  at higher notional sizes — this makes the stop-cap slightly optimistic at
  larger position sizes than the 100 USDT default tested here.
- The gainers/losers/favorites symbol universe is not, and cannot be, part
  of this backtest — see the scope note under Overview.

## Next steps

1. Re-run iteration 3 (0.5x ATR stop buffer, trailing multiplier back to
   1.5x) on both PENGUUSDT and BTCUSDT, same date range, and compare directly
   against the v1 numbers above — does average loss size shrink, and does
   win rate improve, as hypothesized?
2. If it helps, test one more variable at a time from the list under
   Backtest results (more symbols, a higher commission assumption) rather
   than changing several things at once.
3. Once a configuration looks genuinely better (not just on this one date
   range), the next real piece of work is the engine-side scanner
   (top gainers/losers + favorites → candidate selection → tie-breaking rule
   when multiple symbols qualify at once) — not yet designed.
4. This project's engine has **no stop-loss/take-profit order support at
   all** today (`apps/engine`'s `Broker` interface only places market
   entries/exits driven by signals — see `CLAUDE.md`). Promoting this
   strategy into the engine would require building that first, not just
   porting the entry logic.
5. The known TP1-misdetection bug (see Backtest results, iteration 4) is
   still unfixed. If revisited, try the single-always-active-stop-order +
   manual `strategy.close()` redesign sketched there instead of resting
   multiple `strategy.exit()` orders against the same entry — that's the
   root cause of all three failed attempts this round.
