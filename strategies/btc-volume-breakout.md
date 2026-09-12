# BTC Volume Breakout

**Status:** backtested — thirteen backtests run in TradingView's Strategy
Tester (see Backtest notes and Verdict), including a cross-symbol
replication (ETH) and a trend-filter variant that produced the strongest
result of the project. Worth a `paper` allocation with `useTrendFilter=true`
long-only; not yet ported into `apps/engine/src/strategy/` (see Next steps)
and not worth live capital yet.

## Overview

A volume-confirmed range-breakout strategy: instead of trading every touch of
a recent high/low, it only enters when price actually pushes through that
level *and* the bar doing so has unusually heavy volume behind it — the
thesis being that a breakout on weak volume is far more likely to be a
fakeout that snaps back, while a breakout on a genuine volume spike is more
likely to be real participation. Both directions are traded (long on a
resistance break, short on a support break).

## Entry logic

- **Key level**: a rolling 20-bar Donchian channel — the highest high and
  lowest low of the prior 20 *closed* 1h bars, excluding the current bar
  (so the level itself never includes the breakout bar).
- **Long**: current bar's `close` is above the upper Donchian level (the
  bar has to actually close through it, not just wick through — see
  Backtest notes for why this changed from the original wick-through
  trigger), **and** current bar's volume is more than 2.0x its own 20-bar
  average volume (also computed on the prior 20 bars, excluding the
  current one).
- **Short**: current bar's `close` is below the lower Donchian level, with
  the same volume condition. **`allowShorts` input (default OFF as of the
  sixth backtest) can disable short entries entirely** — see Backtest notes
  for why.
- **Optional trend-alignment filter (`useTrendFilter`, default OFF)**: when
  enabled, a long additionally requires `close` above a longer-term SMA
  (`trendMALen`, default 200) and a short additionally requires `close`
  below it — i.e. only take the breakout if it agrees with the prevailing
  trend. A proposed fix for the short-side underperformance found in the
  sixth backtest, not yet tested — see Backtest notes.
- Entries are only taken while flat. A breakout signal in the opposite
  direction while a position is already open is ignored rather than
  flipping the position — see Exit rules below for why.

## Stop loss logic

- **1.5x ATR(14)** from the entry price, in the adverse direction — a
  volatility-adjusted stop rather than a fixed percentage, since BTC's
  typical hourly range shifts a lot over time.

## Take profit logic

- **Fixed 2:1 reward-to-risk, commission-corrected**: the target distance is
  `2 × stopDistance + 3 × commissionCost` (not simply `2 × stopDistance`) —
  see Position sizing below for why the extra term is needed to actually
  realize a 2:1 payout after commission, not just a 2:1-labeled price
  distance that pays out less once fees are subtracted.

## Exit rules

- Stop loss or take profit only. No signal-reversal exit and no time-based
  exit — deliberately, to keep the breakout thesis clean (a position isn't
  closed just because an opposite-direction breakout condition fires; it
  waits for its own stop or target). This does mean a position can sit
  through an opposite breakout signal that would have been profitable to
  take — a real, known tradeoff of this choice, not an oversight.

## Position sizing

- **Fixed 1% risk per trade, commission-aware**: `qty = riskAmount /
  (stopDistance + entryPrice * commissionPctPerSide/100 * 2)`, where
  `riskAmount = equity * 1%`. This is a fix, not the original design — see
  Backtest notes for what the naive version (`qty = riskAmount /
  stopDistance`) actually did in the first real backtest.
- **Why commission has to be in the denominator**: on BTC 1h, `1.5x
  ATR(14)` is typically only ~0.3-0.5% of price. Sizing `qty` to risk 1% of
  equity against a stop that tight produces a notional position
  (`qty * price`) routinely 2-2.5x total account equity — and round-trip
  commission (0.1% in, 0.1% out = 0.2%) on that notional costs roughly
  *another* 0.5% of equity on top of the intended 1% price risk, on every
  single trade, win or lose. Netting the commission cost out of the risk
  budget up front keeps the *realized* loss on a stop-out at ~1% of equity,
  as intended, instead of ~1.5%.
- **This alone is not sufficient** — a real second bug found in the second
  backtest run: sizing `qty` off `(stopDistance + commissionCost)` correctly
  pins the *loss* side at exactly `riskAmount`, but applying that same
  `qty` against a naive `2 x stopDistance` target under-delivers the win:
  `win = qty * (2*stopDistance - commissionCost)`, which is measurably less
  than `2 x riskAmount` once commission is nonzero. This is why the first
  fix alone only moved the backtest from -46.4% to -36.4% instead of fixing
  it — the realized reward:risk barely moved (1.424 -> 1.449). The take
  profit distance itself has to widen by `(R+1) x commissionCost` on top of
  `R x stopDistance` to compensate — see Take profit logic above. Worked
  out algebraically: with that widened target, `win = qty * R *
  (stopDistance + commissionCost) = R x riskAmount` exactly, matching the
  loss side's `riskAmount` exactly by construction. Both sides are now
  commission-corrected, not just one.
- **`commissionPctPerSide` (default **0.05**, changed from an initial 0.1 —
  see Backtest notes) must be kept in sync with `commission_value` in the
  `strategy()` declaration by hand** — `commission_value` is a compile-time
  argument to `strategy()`, so it can't just reference the input directly.
  If one is ever changed without the other, the sizing formula silently
  stops matching the simulated fee. 0.05 matches Binance USDT-M futures'
  standard VIP0 taker fee (no BNB discount) — the original 0.1 default was
  borrowed from `PaperBroker`'s conservative fee assumption, not the real
  exchange rate, and was overstating commission drag by roughly 2x.
- **10x leverage** — this only changes the margin required to hold the
  risk-sized position (`margin = notional / 10`), not the risk per trade
  itself.

## Targets

- **Market/timeframe**: BTCUSDT.P (perpetual futures), 1h candles.
- **Regime**: intended for genuine trending/expansion moves — a breakout
  strategy is expected to do poorly in a choppy range where levels keep
  getting tagged and reversed, even with the volume filter.
- **Performance expectations**: none yet — exploratory, no target win rate,
  R:R, or drawdown has been set. Establish this from the first backtest
  before judging it.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Donchian lookback | 20 bars | prior closed 1h bars, excludes current bar |
| Volume lookback | 20 bars | average volume window, excludes current bar |
| Volume multiplier | 2.0x | current bar volume must exceed avg x this to count as "heavy" |
| ATR period | 14 | stop distance basis |
| ATR stop multiplier | 1.5x | stop = entry ± 1.5 × ATR(14) |
| Reward:risk | 2:1 | target = entry ± 2 × stop distance |
| Risk per trade | 1% of equity | qty derived from stop distance + commission, not a flat % of equity |
| Commission per side | 0.05% | Binance USDT-M futures standard taker fee; must match `commission_value`, kept in sync by hand |
| Leverage | 10x | affects margin requirement only, not risk sizing |

## Pine Script v6

Position size is computed manually from the risk/stop distance (not
`percent_of_equity`), so `default_qty_type=strategy.fixed` with `qty` set
per entry. `margin_long`/`margin_short` are set to `100 / 10 = 10` to match
the 10x leverage — Pine v6 defaults both to 100 (no leverage) unless set
explicitly. `process_orders_on_close=true` so decisions evaluate on the
closed bar, matching the engine's own candle-close-only cadence. Commission
defaults to **0.05%** — Binance USDT-M futures' real standard taker fee
(changed from an initial 0.1%, which was `PaperBroker`'s more conservative
assumption rather than the real exchange rate; see Backtest notes) — and
`f_qtyForRisk`/`f_targetDistance` net that same 0.05%, doubled for the
round trip, out of the risk budget before sizing (see Position sizing
above for why).

```pinescript
//@version=6
strategy(
     "BTC Volume Breakout (20/2.0x/ATR14x1.5/2R, 10x)",
     overlay=true,
     default_qty_type=strategy.fixed,
     default_qty_value=0,
     margin_long=10,
     margin_short=10,
     commission_type=strategy.commission.percent,
     commission_value=0.05,
     process_orders_on_close=true)

donchianLookback = input.int(20, "Donchian lookback (bars)", minval=1)
volLookback       = input.int(20, "Volume average lookback (bars)", minval=1)
volMultiplier     = input.float(2.0, "Volume multiplier (\"heavy volume\")", minval=0.1, step=0.1)
atrPeriod         = input.int(14, "ATR period", minval=1)
atrStopMult       = input.float(1.5, "ATR stop multiplier", minval=0.1, step=0.1)
rewardRiskRatio   = input.float(2.0, "Reward:risk ratio", minval=0.1, step=0.1)
riskPct           = input.float(1.0, "Risk % of equity per trade", minval=0.01, step=0.1)
leverage          = input.float(10, "Leverage (see margin_long/short note above)", minval=1, maxval=125, step=1)
// Must match commission_value above by hand - see Position sizing's note
// on why this can't just reference commission_value directly. 0.05 = real
// Binance USDT-M futures standard taker fee (VIP0, no BNB discount).
commissionPctPerSide = input.float(0.05, "Commission % per side (keep in sync with commission_value)", minval=0, step=0.01)

// Excludes the current bar from both the level and the volume average, so
// neither is contaminated by the breakout bar itself.
upperLevel = ta.highest(high[1], donchianLookback)
lowerLevel = ta.lowest(low[1], donchianLookback)
volAvg     = ta.sma(volume[1], volLookback)
atrValue   = ta.atr(atrPeriod)

heavyVolume    = volume > volAvg * volMultiplier
// Close-beyond-level, not wick-through (changed after backtesting - see
// Backtest notes): a wick that immediately reverses is exactly the fakeout
// the volume filter is meant to catch, and wick-through was letting some
// of those through anyway since a big wick can spike volume too.

// Found live (sixth backtest): longs profitable, shorts the drag - BTC ran
// a strong uptrend across most of the tested window. allowShorts isolates
// long-only performance; useTrendFilter is a proposed actual fix (both
// sides get more selective, not just shorts disabled) - see Backtest notes.
allowShorts    = input.bool(false, "Allow short entries (OFF isolates long-only)")
useTrendFilter = input.bool(false, "Require trend alignment (price vs trend MA) - proposed short fix")
trendMALen     = input.int(200, "Trend filter SMA length", minval=1)
trendMA        = ta.sma(close, trendMALen)
trendAllowsLong  = not useTrendFilter or close > trendMA
trendAllowsShort = not useTrendFilter or close < trendMA

longCondition  = close > upperLevel and heavyVolume and strategy.position_size == 0 and trendAllowsLong
shortCondition = allowShorts and close < lowerLevel and heavyVolume and strategy.position_size == 0 and trendAllowsShort

// Nets round-trip commission out of the risk budget up front, so the
// REALIZED loss on a stop-out (price move + commission) lands at ~riskPct
// of equity, not price-move-alone at riskPct with commission on top of
// that. See Position sizing's note above for the real numbers this fixed.
f_qtyForRisk(stopDistance, entryPrice) =>
    riskAmount = strategy.equity * riskPct / 100
    commissionCost = entryPrice * (commissionPctPerSide / 100) * 2
    denom = stopDistance + commissionCost
    denom > 0 ? riskAmount / denom : 0.0

// qty above sizes off (stopDistance + commissionCost), so a naive
// R x stopDistance target under-delivers once commission is subtracted
// from the win too (win = qty*(R*stopDistance - commissionCost), not
// R x riskAmount). Widening the target by (R+1) x commissionCost exactly
// cancels that - see Take profit logic above for the worked-out algebra.
f_targetDistance(stopDistance, entryPrice) =>
    commissionCost = entryPrice * (commissionPctPerSide / 100) * 2
    rewardRiskRatio * stopDistance + (rewardRiskRatio + 1) * commissionCost

if longCondition
    stopDistance = atrValue * atrStopMult
    qty = f_qtyForRisk(stopDistance, close)
    stopPrice = close - stopDistance
    targetPrice = close + f_targetDistance(stopDistance, close)
    strategy.entry("Long", strategy.long, qty=qty)
    strategy.exit("Exit-Long", from_entry="Long", stop=stopPrice, limit=targetPrice)

if shortCondition
    stopDistance = atrValue * atrStopMult
    qty = f_qtyForRisk(stopDistance, close)
    stopPrice = close + stopDistance
    targetPrice = close - f_targetDistance(stopDistance, close)
    strategy.entry("Short", strategy.short, qty=qty)
    strategy.exit("Exit-Short", from_entry="Short", stop=stopPrice, limit=targetPrice)

plot(upperLevel, "Donchian upper", color=color.green)
plot(lowerLevel, "Donchian lower", color=color.red)
plot(volAvg * volMultiplier, "Heavy volume threshold", color=color.purple, display=display.data_window)
plot(useTrendFilter ? trendMA : na, "Trend filter SMA", color=color.orange)
```

## Backtest notes

- **First real backtest (before this fix), recorded honestly rather than
  erased**: BTCUSDT.P 1h, 300 closed trades, 35.0% win rate, profit factor
  0.77, equity 1,000,000 → 536,160 (**-46.4%**), ~50.7% max drawdown. Root
  cause traced via Pine Logs (`log.info()` diagnostic build in
  `strategies/btc-volume-breakout.tmp.pine`): the original
  `qty = riskAmount / stopDistance` formula ignored that commission is
  charged on notional, not on risk. On this symbol/timeframe the tight ATR
  stop routinely sized notional to 2-2.5x equity, so round-trip commission
  cost ~50% of the intended 1% risk *on top of* that 1%, on every trade —
  shrinking the realized reward:risk from the designed 2:1 down to ~1.42:1
  (avg win $14,527 / avg loss $10,201). At 35% win rate, 1.42:1 is a net
  loser (breakeven needs ~41%) even though 2:1 at 35% would have been
  marginally profitable before costs.
- **Second real backtest (qty fix only, target distance not yet fixed)**:
  same 300 trades (entry/stop/target price *levels* are identical — only
  `qty` changed, so which trades win/lose can't change), 35.0% win rate
  (195 STOP / 105 TARGET, confirmed exactly matching win/loss counts once
  the log's own STOP-vs-TARGET labeling bug was also fixed — see below),
  profit factor 0.78, equity 1,000,000 → 632,435 (**-36.4%**, better than
  -46.4% but still a clear loser), ~41.5% max drawdown. Realized R:R barely
  moved (1.424 → 1.449) despite the qty fix, because sizing `qty` off
  `(stopDistance + commissionCost)` correctly pins the *loss* at exactly
  `riskAmount`, but the *win* — still computed against a naive
  `2 x stopDistance` target — comes out to `qty*(2*stopDistance -
  commissionCost)`, measurably less than `2 x riskAmount`. Fixed by
  widening the target distance itself (see Take profit logic and the Pine
  code above); **this second fix has not yet been re-run either** — treat
  every number in this bullet as describing the qty-only-fixed formula, not
  the current (both-sides-fixed) one.
- **Diagnostic logging bug found and fixed alongside the qty fix**: the
  `.tmp.pine` scratch file's `log.info()` STOP/TARGET reason label was
  wrong on any trade where a new entry fired on the same bar as the
  previous trade's close — the entry logic ran first and overwrote the
  `lastStopPrice`/`lastTargetPrice` vars the close-reason comparison
  depended on, before the close was logged. Reordered so the close check
  runs before any same-bar entry can touch those vars. Not a strategy-logic
  bug, just a diagnostic-instrumentation one, but it made the first
  backtest's log look worse-labeled than it was (e.g. target hits mislabeled
  `STOP`) until fixed.
- **Third real backtest (both fixes applied, commission still 0.1%)**: 252
  closed trades (down from 300 — trades stay open longer against a wider
  target, so fewer complete in the same window), win rate **26.2%** (186
  STOP / 66 TARGET), profit factor 0.72, equity 1,000,000 → 574,151
  (**-43.4%**), ~50.2% max drawdown. Realized R:R came out to **2.017:1**
  — confirming the target-widening algebra is exactly correct, not another
  bug — but win rate collapsed from 35.0% to 26.2% as a direct consequence:
  a wider target means price has to travel further before reversing back to
  the (unchanged) stop, so trades that used to reach the tighter 2R target
  under the old formula now get stopped out first instead. At 26.2% win
  rate with a genuine 2:1 payout, expected value is `0.262*2 - 0.738*1 =
  -0.214R` per trade — clearly, honestly negative. This is the entry
  signal's real edge (or lack of it) once both sizing bugs are fixed and
  the payout is measured truthfully — not a sizing artifact to keep
  patching.
- **Commission assumption revised after the third run**: `commissionPctPerSide`/
  `commission_value` were `0.1%` (matching `PaperBroker`'s conservative
  assumption) for all three runs above. Real Binance USDT-M futures'
  standard taker fee is `0.05%` (VIP0, no BNB discount) — roughly half.
  Since the target-widening term is `(R+1) x commissionCost`, halving the
  commission rate roughly halves that widening too, which should partially
  recover some of the win rate lost between run 2 and run 3.
- **Fourth real backtest (both fixes, realistic 0.05% commission)**: 276
  closed trades, win rate **30.1%** (193 STOP / 83 TARGET), profit factor
  0.86, equity 1,000,000 → 750,051 (**-25.0%**), ~40.8% max drawdown.
  Realized R:R came out to **2.001:1** — essentially identical to run 3's
  2.017:1 despite a completely different commission rate, which is strong
  independent confirmation the sizing/target-widening math is actually
  correct (not luck): two separate runs, two different commission inputs,
  both land within 0.02 of the designed 2.000 target. Win rate recovered
  from 26.2% to 30.1% exactly as predicted (less commission → less
  target-widening → closer target → easier to reach before the stop).
  **Breakeven win rate at a true 2:1 payout is 33.3%; actual is 30.1% —
  only ~3 points short.** Expected value: `0.301*2 - 0.699*1 = -0.098R`
  per trade. This is a real but modest negative edge, not a sizing bug —
  both sizing bugs are now fixed and independently cross-validated.
- **Entry trigger changed from wick-through to close-beyond-level** after
  the fourth backtest, to try to close the remaining ~3-point win-rate gap:
  a wick that immediately reverses is exactly the fakeout the volume
  filter is supposed to catch, but wick-through was letting some through
  anyway (a large reversal wick can spike volume on its own). Requiring
  the close to hold beyond the level is a stricter, more conservative
  trigger — expected to reduce trade count and should filter out at least
  some of the false breakouts that were previously getting stopped out.
- **Fifth real backtest (close-beyond-level trigger)**: 204 closed trades
  (down from 276 — the stricter trigger takes fewer, higher-conviction
  signals, as expected), win rate **32.84%** (137 STOP / 67 TARGET), profit
  factor **0.967**, realized R:R **1.978** (still ~2, consistent with the
  three prior runs — sizing math holds up across a fourth independent
  configuration), equity 1,000,000 → 950,992 (**-4.9%**), ~30.2% max
  drawdown. This is a large jump from run 4's -25.0% — the close-beyond-level
  trigger meaningfully helped, exactly as hypothesized (a wick that
  immediately reverses is the fakeout the volume filter is meant to catch,
  and letting a wick alone trigger entry was undermining that).
  **Statistically, this result is indistinguishable from breakeven**:
  breakeven win rate at R:R≈2 is 33.3%, actual is 32.84% — a 0.46-point
  gap, but the standard error on a 204-trade win rate this size is ~3.3
  points. This single backtest window cannot tell us whether the true edge
  is slightly positive, slightly negative, or exactly zero. Worth treating
  as "promising, not proven" rather than either "fixed" or "still broken."
- **Out-of-sample test attempted, found infeasible on this account**: every
  parameter and rule choice above (entry trigger, volume multiplier, ATR
  stop multiplier, even the commission fix) was picked while looking at
  results from 2026-01-01 through 2026-09-08 — that entire window is
  in-sample. `.tmp.pine` gained `backtestStart`/`backtestEnd` inputs plus a
  `bgcolor` shading the active range so a date split would be explicit and
  reproducible, defaulted to all of 2025 (the year immediately before the
  tuned window) — but this account's TradingView plan caps 1h chart history
  at 5,000 bars (~208 days), which only reaches back to roughly mid-February
  2026 at best, still *inside* the tuned window, not before it. Genuine
  historical out-of-sample testing on this symbol/timeframe isn't reachable
  without a plan upgrade. The date-filter inputs are left in place
  (defaulted wide open, 2020-2030, so they don't silently filter anything
  out) for whenever deeper history becomes available.
- **Parameter-sensitivity check chosen as the practical alternative**: since
  fresh out-of-sample data isn't accessible right now, the next check is
  whether the ~32.84% win rate holds in a neighborhood around the tuned
  parameter values (e.g. `volMultiplier` 1.8/2.0/2.2, `atrStopMult`
  1.3/1.5/1.7) rather than being a narrow spike only at the exact tuned
  numbers — a stable neighborhood is evidence against overfitting even
  without new data; a knife-edge peak is evidence the tuning just found
  noise in this one sample. Results not yet recorded (the compile/deploy
  friction below interrupted the sweep before any variant besides the
  baseline was actually verified changed).
- **Deploy friction hit while attempting the sensitivity sweep**: driving
  the browser directly (via claude-in-chrome) to change inputs and re-run
  turned out to be unreliable — the on-chart script instance couldn't be
  cleanly located/edited through the UI at first, and once a fresh script
  was pasted and saved, TradingView's compile endpoint
  (`pine-facade.tradingview.com`) returned `503` on every "Add to chart"
  attempt (4 retries). TradingView's own status page showed all systems
  operational at the time, including Pine Script specifically, so this
  wasn't a platform-wide outage — most likely an ad-blocker-related
  degradation on the free/ad-supported plan tier (a "your plan needs ads
  allowed" prompt appeared right before the failures started), though not
  confirmed. Not resolved from the browser side; the user ran the script
  from the TradingView desktop app instead, which worked.
- **Sixth backtest observation (via desktop app, no log export this time)**:
  longs profitable, shorts the drag on overall performance. Plausible cause,
  not yet confirmed: BTC ran a strong uptrend (~62k to 92k+) across most of
  the tested window, so short breakdowns were fighting the prevailing trend
  while long breakouts rode it — more likely a directional-bias artifact of
  this specific sample than a flaw in the short-side logic itself. Two
  independently-toggleable experiments added to test this rather than
  guessing: `allowShorts` (default **OFF** — isolates long-only performance,
  run this first) and `useTrendFilter` (default OFF — a proposed actual fix:
  requires the breakout to align with a longer-term trend, price vs a
  200-period SMA, in EITHER direction, rather than just disabling shorts
  permanently). Neither has been run yet.
- **Known sizing gap, still present after both fixes**: `qty` has no cap
  against available margin. On a bar where ATR is unusually small relative
  to price, the risk-sized `qty` could still require more margin than
  `equity × leverage` allows — Pine will reject/clip the order rather than
  silently over-risking, but that means the backtest result can understate
  real trade count if this triggers often. Worth checking the Strategy
  Tester's rejected-orders behavior on the next run.
- **Wick-through trigger is evaluated at bar close, not truly intrabar**:
  because `process_orders_on_close=true`, the `high > upperLevel` / `low <
  lowerLevel` check only runs once the 1h bar has fully closed and its wick
  is already known — this matches the live engine's own candle-close-only
  decision cadence (see `apps/engine/src/marketData/binanceKlineStream.ts`),
  but means neither this backtest nor a future engine port would ever enter
  mid-bar the instant the wick occurs.
- **No cooldown after a stop-out**: nothing prevents a fresh breakout
  condition from firing on the very next bar after a stop loss, in either
  direction — a choppy period could produce a rapid sequence of stopped-out
  breakout attempts. This is deliberate (no rule for it was specified), not
  a bug, but worth watching in the trade list.
- TradingView's Strategy Tester and a live engine will not produce
  identical trade-for-trade results even on the same symbol/interval: fill
  price assumptions, historical data source, and exact candle-close timing
  differ. Use this for directional insight (does the logic even work?), not
  as a precise prediction of live behavior.

- **Seventh backtest (long-only isolation, `allowShorts=false` — the "run
  this first" experiment from the sixth backtest note)**: BTCUSDT.P 1h,
  2026-01-01 to 2026-09-07 (same in-sample tuned window as every prior run),
  104 closed trades, all LONG (0 shorts, as expected with the flag off), win
  rate **34.62%** (68 STOP / 36 TARGET), profit factor **1.043**, realized
  R:R **1.971** (consistent with every prior run — sizing math holds up a
  fifth independent way), equity 1,000,000 → 1,029,809 (**+2.98%**), max
  drawdown **16.77%**. Directly confirms the sixth backtest's hypothesis:
  isolating out shorts recovers the fifth backtest's -4.9%/30.2% DD (204
  mixed trades) to a small **positive** return with roughly half the
  drawdown. Price context worth noting: BTC ranged ~59k-97k across this
  window and ended net **-9.6%** (88,800 → 80,301) — not a one-directional
  bull run, so this small long-side edge isn't simply beta from an uptrend,
  though the sample is still short and entirely in-sample.
  **Still statistically indistinguishable from breakeven**: breakeven win
  rate at R:R≈1.97 is 33.66%, actual is 34.62% — only 0.96 points above,
  against a standard error of ~4.7 points at n=104 (95% CI roughly
  [25%, 44%], comfortably spanning breakeven). Same "promising, not proven"
  read as the fifth backtest, now on a cleaner (long-only) rule set.
  `useTrendFilter=true` and the parameter-sensitivity sweep (both proposed
  after the fifth/sixth backtests) are still the two outstanding checks —
  neither has been run yet.
- **Parameter-sensitivity sweep (eighth-eleventh backtests)**, all BTCUSDT.P
  1h, same tuned window, `allowShorts=false`, one input changed at a time
  from the seventh backtest's baseline (`volMultiplier=2.0`,
  `atrStopMult=1.5`):

  | Config | Trades | Win rate | Profit factor | Return | Max DD |
  |---|---|---|---|---|---|
  | 2.0 / 1.5 (baseline) | 104 | 34.62% | 1.043 | +2.98% | 16.77% |
  | 1.8 / 1.5 | 107 | 34.58% | 1.042 | +2.95% | 17.21% |
  | 2.2 / 1.5 | 100 | 35.00% | 1.062 | +4.05% | 15.51% |
  | 2.0 / 1.3 | 110 | 32.73% | 0.956 | -3.05% | 18.98% |
  | 2.0 / 1.7 | 100 | 32.00% | 0.924 | -4.86% | 18.24% |

  `volMultiplier` looks stable (all three values positive, within 0.4 points
  of each other). `atrStopMult` looks fragile at first glance — both
  neighbors of 1.5 flip to a loss — but the actual math says otherwise:
  every win-rate difference in this table, computed as a two-proportion
  z-test against the 104-trade baseline, comes out to z≈0.01-0.40 (need
  ~1.96 to call something a real difference). With only ~100-110 trades per
  config, a swing of 2-3 win-rate points is well inside sampling noise —
  this sweep is **inconclusive**, not evidence of either a stable edge or a
  knife-edge overfit. The honest read: 8 backtests in, none has produced a
  result strong enough to distinguish from chance on its own.
- **Cross-symbol check (twelfth backtest) — ETHUSDT.P, rules completely
  unchanged** from the seventh backtest's BTC baseline (same dates,
  `volMultiplier=2.0`, `atrStopMult=1.5`, `allowShorts=false`,
  `useTrendFilter=false`): 84 closed trades, win rate **34.52%** (29W/55L),
  profit factor **1.04**, return **+2.16%**, max drawdown **11.92%**.
  Realized R:R backed out from PF and win/loss counts: **1.972** — line for
  line matching BTC's ~1.97-2.0 across every prior run. This is the most
  reassuring result of the whole project so far: nearly identical win rate
  (34.52% vs BTC's 34.62%, a 0.10-point gap — z≈0.01, indistinguishable) and
  identical realized R:R on a completely different asset's price data. Pure
  overfitting to BTC's specific historical path would not be expected to
  reproduce this precisely on independent data — this is real (if small)
  evidence the entry/exit logic itself has a genuine, if modest, edge.
- **Trend filter check (thirteenth backtest) — BTCUSDT.P, `useTrendFilter=true`**,
  otherwise identical to the seventh backtest's baseline: 74 closed trades,
  win rate **39.19%** (29W/45L), profit factor **1.262**, return **+12.96%**,
  max drawdown **11.23%** — the best single result across all thirteen
  backtests, on every metric simultaneously. Realized R:R **1.958** (still
  consistent with the sizing math). Breakeven win rate at this R:R is
  33.80%; actual is 5.39 points above it — the largest margin seen, though
  at n=74 the standard error (~5.7 points) still keeps this short of
  formal statistical significance on its own. Directionally, this is exactly
  the outcome the sixth backtest's trend-alignment hypothesis predicted, not
  an arbitrary win. **Not cross-validated on ETH** — the natural next check
  (ETHUSDT.P with the trend filter also on, completing the 2×2
  symbol × filter matrix) was proposed but not run; the operator chose to
  stop testing here rather than run it.

## Verdict (as of the thirteenth backtest, 2026-09-10)

Two independent, converging pieces of evidence, weighed against everything
still unverified:

- **For**: the base long-only entry logic reproduces itself almost exactly
  on a second, independent asset (ETH) — real evidence against "this is
  just noise fit to BTC's price history." Adding the trend filter produced
  the strongest result of the project by a clear margin, consistent with a
  specific, explainable mechanism (only take breakouts that agree with the
  prevailing trend) rather than an arbitrary lucky config.
- **Against**: every number in this document comes from the same
  2026-01-01 to 2026-09-08 window — true out-of-sample testing has never
  been possible on this account (5,000-bar history cap). The trend-filter
  result specifically has not been cross-validated on ETH the way the base
  logic was, and at n=74 it isn't statistically proven on its own. The base
  edge without the trend filter, even where replicated, is still small
  enough (~1 point over breakeven) to be within noise on any single run.

**Decision: promote to `backtested` lifecycle state, worth a `paper`
allocation with `useTrendFilter=true`, not worth live capital yet.** The
combination of cross-asset replication (on the base logic) and a
mechanism-consistent, large improvement (from the trend filter) clears a
meaningfully higher bar than any single backtest number could on its own —
but neither the sample sizes nor the in-sample-only history support going
straight to live capital. Paper trading is also the only way left to get
genuine forward (truly out-of-sample) data, since deeper historical
out-of-sample testing isn't available on this account — so further
backtest-tuning of this rule set has diminishing returns compared to
just letting it run forward and watching.

## Next steps

1. **Port this into `apps/engine/src/strategy/`** as a real
   `StrategyAlgorithm` (see `movingAverageCross.ts` for the simplest
   existing example, `btcHighRisk.ts` for the most complete) — Donchian
   breakout + volume filter + ATR stop + commission-aware 2R target +
   trend-alignment filter, long-only (`allowShorts` stays off; nothing here
   validated shorts). This is real development work, not a config flip —
   not started yet.
2. Add it to the `catalog` array in `index.ts`'s `main()` so it shows up in
   Mongo/the dashboard — it will default to `enabled: false`, per every
   strategy's fresh-deployment default (see CLAUDE.md's Enabling/disabling
   strategies section).
3. Enable it from the dashboard once ported, with `lifecycleState: "paper"`
   — watch it accumulate genuinely forward trades before ever considering
   `live_small`.
