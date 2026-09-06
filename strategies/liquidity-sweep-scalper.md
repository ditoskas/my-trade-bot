# Liquidity Sweep Scalper

**Status:** draft — untested. Sourced from a ChatGPT-generated Pine v6 script
(https://chatgpt.com/share/6a9d1879-9690-83eb-a60a-7585f11a4933, "v2"), not a
strategy anyone has run a live backtest on yet. Documented here as a summary
of that final result, not the back-and-forth that produced it. Two real Pine
compile issues in the source were found and fixed before this could actually
run — see Backtest notes.

## Overview

Multi-timeframe liquidity-sweep-and-reclaim scalper for BTCUSDT.P: trades the
reversal when price wicks through a known liquidity level (a prior 5m swing,
the previous day's high/low, or the Asian session's high/low) and then
reclaims it with momentum, filtered by 15m trend alignment and session/
volatility/volume conditions. 100x leverage ceiling, risk-based position
sizing.

## Entry logic

- **Long**: 15m trend bullish (EMA9 > EMA21 > EMA200, close > VWAP,
  50 < RSI < 72) — a liquidity level below price (5m swing low, previous
  day's low, or Asian session low) gets swept (candle low breaks it, close
  back above) within the last 5 bars — 1m reclaim confirms (EMA9 > EMA21,
  close > VWAP, RSI > 50) — volume ≥ 1.10× the 20-bar average — ATR ≥ 0.03%
  of price — London and/or New York session active.
- **Short**: exact mirror (bearish 15m trend, sweep of a level above price,
  bearish reclaim).

## Stop loss logic

Structural: the sweep candle's own low (long) / high (short), offset by
0.10× ATR, then bounded to 0.08%–0.30% of price — an entry that would need a
stop outside that band is rejected outright rather than taken with an
oversized or undersized stop.

## Take profit logic

Two-stage: TP1 at 1R (closes 50% of the position), TP2 at 2R (remaining
50%). Stop moves to breakeven (+0.02% offset) once TP1 hits. Optional
ATR-multiple trailing stop on the remainder after TP1 (off by default).

## Exit rules

Stop / TP1 / TP2 / breakeven-adjusted stop only — no time-based exit, no
signal-reversal exit.

## Position sizing

Risk-based, not leverage-first: `qty = (account × risk% per trade) / stop
distance`, then capped at `account × 100x` notional (the leverage input is a
ceiling, not a target). Default risk 0.75% of account per trade. Daily
circuit breakers: max 3% daily loss, max 5 trades/day, max 3 consecutive
losses trigger a 10-bar cooldown.

## Targets

- **Market/timeframe**: BTCUSDT.P, 1-minute chart (5m and 15m pulled in via
  `request.security`).
- **Performance expectations** (from the source conversation, not yet
  verified against an actual backtest here): profit factor > 1.3, win rate
  > 45%, max drawdown < 15%, at least 500 closed trades before trusting the
  numbers, checked across multiple distinct periods rather than one
  cherry-picked window. Explicit caveat carried over from the source: real
  exchange execution (spread, latency, liquidation mechanics, funding) can
  differ materially from TradingView's simulated fills at 100x leverage with
  sub-0.3%-wide stops — a good backtest here is a necessary, not sufficient,
  condition.

## Parameters

| Parameter | Default |
|---|---|
| Account size | $1,000 (preset; $500/$5,000/custom also available) |
| Maximum leverage | 100x (ceiling, not target) |
| Risk per trade | 0.75% |
| Max daily loss | 3% |
| Max trades/day | 5 |
| Max consecutive losses | 3 (→ 10-bar cooldown) |
| Sweep validity window | 5 bars (1m) |
| SL buffer | 0.10 × ATR |
| SL bounds | 0.08%–0.30% of price |
| TP1 / TP2 | 1R / 2R |
| TP1 close % | 50% |
| Move to breakeven after TP1 | Yes (+0.02% offset) |
| Trailing stop | Off by default (1.5× ATR when enabled) |
| ATR filter | On, min 0.03% of price |
| Volume filter | On, ≥ 1.10× 20-bar average |
| Equal-high/low tolerance | 0.05% |
| Sessions | London (08:00–13:00) + New York (13:00–21:00), both on |
| Asian session (liquidity source only) | 00:00–08:00 |
| Maker / taker fee | 0.020% / 0.055% |

## Pine Script v6

```pinescript
//@version=6
strategy(
     "BTCUSDT.P 100x Liquidity Sweep Scalper v2",
     overlay = true,
     pyramiding = 0,
     initial_capital = 1000,
     currency = currency.USD,
     // Compile-time constant, not the leverage input below — Pine doesn't
     // allow margin_long/margin_short to reference an input. 1 = 100/100,
     // matching the leverage input's own default (100x). The source script
     // omitted this entirely, which meant Pine's actual margin requirement
     // defaulted to 100 (fully unleveraged) regardless of the 100x sizing
     // math below — the backtest would have silently rejected/clipped any
     // position sized assuming real leverage. Hand-edit this if the
     // leverage input's default ever changes.
     margin_long = 1,
     margin_short = 1,
     commission_type = strategy.commission.percent,
     commission_value = 0.055,
     slippage = 1,
     calc_on_order_fills = true,
     calc_on_every_tick = true,
     process_orders_on_close = true)

// ============================================================================
// BTCUSDT.P LIQUIDITY SWEEP SCALPER v2
//
// Intended chart: 1-minute BTCUSDT perpetual
// Architecture: 15m trend / 5m structure / 1m execution
// Entry: liquidity sweep -> reclaim -> momentum confirmation
// Risk: account % risk -> position size -> leverage ceiling
// Management: TP1 -> partial close -> breakeven -> TP2 (+ optional trail)
// ============================================================================

groupAccount = "01 - ACCOUNT & LEVERAGE"
groupRisk    = "02 - RISK MANAGEMENT"
groupTrend   = "03 - 15m TREND FILTER"
groupEntry   = "04 - ENTRY FILTERS"
groupLiq     = "05 - LIQUIDITY"
groupSession = "06 - SESSION FILTER"
groupExit    = "07 - EXIT MANAGEMENT"
groupCost    = "08 - FEES & SLIPPAGE"
groupVisual  = "09 - VISUALS"

// ---- VISUALS (moved up from the end of the source script — showLabels was
// referenced inside the LONG/SHORT ENTRY blocks below but declared after
// them, an undeclared-identifier compile error under Pine's top-to-bottom
// evaluation. All five toggles live here now, before anything uses them.) ----
showEMAs      = input.bool(true, "Show EMAs", group = groupVisual)
showVWAP      = input.bool(true, "Show VWAP", group = groupVisual)
showLiquidity = input.bool(true, "Show Liquidity", group = groupVisual)
showLabels    = input.bool(true, "Show Trade Labels", group = groupVisual)
showDashboard = input.bool(true, "Show Dashboard", group = groupVisual)

// ---- ACCOUNT ----
accountPreset = input.string("$1,000", "Account Size", options = ["$500", "$1,000", "$5,000", "Custom"], group = groupAccount)
customAccount = input.float(1000, "Custom Account", minval = 10, step = 10, group = groupAccount)
leverage      = input.float(100, "Maximum Leverage", minval = 1, maxval = 100, step = 1, group = groupAccount)

accountSize = accountPreset == "$500" ? 500.0 : accountPreset == "$1,000" ? 1000.0 : accountPreset == "$5,000" ? 5000.0 : customAccount

// ---- RISK ----
riskPercent          = input.float(0.75, "Risk Per Trade (%)", minval = 0.10, maxval = 2.0, step = 0.05, group = groupRisk)
maxDailyLossPercent  = input.float(3.0, "Maximum Daily Loss (%)", minval = 0.5, maxval = 20, step = 0.5, group = groupRisk)
maxTradesPerDay      = input.int(5, "Maximum Trades Per Day", minval = 1, maxval = 50, group = groupRisk)
maxConsecutiveLosses = input.int(3, "Maximum Consecutive Losses", minval = 1, maxval = 10, group = groupRisk)
cooldownBars         = input.int(10, "Cooldown After Losing Trade (bars)", minval = 0, maxval = 240, group = groupRisk)

riskDollars         = accountSize * riskPercent / 100.0
maxDailyLossDollars = accountSize * maxDailyLossPercent / 100.0

// ---- 15 MINUTE TREND FILTER ----
ema9_15   = request.security(syminfo.tickerid, "15", ta.ema(close, 9), lookahead = barmerge.lookahead_off)
ema21_15  = request.security(syminfo.tickerid, "15", ta.ema(close, 21), lookahead = barmerge.lookahead_off)
ema200_15 = request.security(syminfo.tickerid, "15", ta.ema(close, 200), lookahead = barmerge.lookahead_off)
rsi15     = request.security(syminfo.tickerid, "15", ta.rsi(close, 14), lookahead = barmerge.lookahead_off)
vwap15    = request.security(syminfo.tickerid, "15", ta.vwap(hlc3), lookahead = barmerge.lookahead_off)
close15   = request.security(syminfo.tickerid, "15", close, lookahead = barmerge.lookahead_off)

longTrend  = ema9_15 > ema21_15 and ema21_15 > ema200_15 and close15 > vwap15 and rsi15 > 50 and rsi15 < 72
shortTrend = ema9_15 < ema21_15 and ema21_15 < ema200_15 and close15 < vwap15 and rsi15 < 50 and rsi15 > 28

// ---- 5 MINUTE STRUCTURE ----
pivotHigh5 = request.security(syminfo.tickerid, "5", ta.pivothigh(high, 3, 3), lookahead = barmerge.lookahead_off)
pivotLow5  = request.security(syminfo.tickerid, "5", ta.pivotlow(low, 3, 3), lookahead = barmerge.lookahead_off)

var float swingHigh = na
var float swingLow  = na
if not na(pivotHigh5)
    swingHigh := pivotHigh5
if not na(pivotLow5)
    swingLow := pivotLow5

// ---- PREVIOUS DAY HIGH / LOW ----
previousDayHigh = request.security(syminfo.tickerid, "D", high[1], lookahead = barmerge.lookahead_off)
previousDayLow  = request.security(syminfo.tickerid, "D", low[1], lookahead = barmerge.lookahead_off)

// ---- ASIAN SESSION HIGH / LOW ----
asianSession = input.session("0000-0800", "Asian Session", group = groupSession)
inAsian      = not na(time(timeframe.period, asianSession))

var float asianHigh = na
var float asianLow  = na
asianStart = inAsian and not inAsian[1]
if asianStart
    asianHigh := high
    asianLow := low
else if inAsian
    asianHigh := math.max(asianHigh, high)
    asianLow := math.min(asianLow, low)

// ---- SESSION FILTER ----
useLondon        = input.bool(true, "Trade London", group = groupSession)
useNewYork       = input.bool(true, "Trade New York", group = groupSession)
londonSession    = input.session("0800-1300", "London Session", group = groupSession)
newYorkSession   = input.session("1300-2100", "New York Session", group = groupSession)
useSessionFilter = input.bool(true, "Use Session Filter", group = groupSession)

inLondon  = not na(time(timeframe.period, londonSession))
inNewYork = not na(time(timeframe.period, newYorkSession))
sessionOK = (useLondon and inLondon) or (useNewYork and inNewYork)
sessionAllowed = not useSessionFilter or sessionOK

// ---- 1 MINUTE INDICATORS ----
ema9  = ta.ema(close, 9)
ema21 = ta.ema(close, 21)
ema200 = ta.ema(close, 200)
rsi   = ta.rsi(close, 14)
vwap  = ta.vwap(hlc3)
atr   = ta.atr(14)
averageVolume = ta.sma(volume, 20)

// ---- ATR VOLATILITY FILTER ----
useATRFilter  = input.bool(true, "Use ATR Filter", group = groupEntry)
minATRPercent = input.float(0.03, "Minimum ATR (%)", minval = 0.001, maxval = 2, step = 0.005, group = groupEntry)
atrPercent    = atr / close * 100
atrOK         = not useATRFilter or atrPercent >= minATRPercent

// ---- VOLUME FILTER ----
useVolume        = input.bool(true, "Require Volume Confirmation", group = groupEntry)
volumeMultiplier = input.float(1.10, "Volume vs 20-bar Average", minval = 0.5, maxval = 5, step = 0.05, group = groupEntry)
volumeOK         = not useVolume or volume >= averageVolume * volumeMultiplier

// ---- LIQUIDITY SOURCES ----
useSwingLiquidity       = input.bool(true, "5m Swing High/Low", group = groupLiq)
usePreviousDayLiquidity = input.bool(true, "Previous Day High/Low", group = groupLiq)
useAsianLiquidity       = input.bool(true, "Asian High/Low", group = groupLiq)

// ---- FIND NEAREST LIQUIDITY LEVELS ----
float longLiquidity = na
float shortLiquidity = na

if useSwingLiquidity and not na(swingLow) and swingLow < close
    longLiquidity := swingLow
if usePreviousDayLiquidity and previousDayLow < close
    if na(longLiquidity) or math.abs(close - previousDayLow) < math.abs(close - longLiquidity)
        longLiquidity := previousDayLow
if useAsianLiquidity and not na(asianLow) and asianLow < close
    if na(longLiquidity) or math.abs(close - asianLow) < math.abs(close - longLiquidity)
        longLiquidity := asianLow

if useSwingLiquidity and not na(swingHigh) and swingHigh > close
    shortLiquidity := swingHigh
if usePreviousDayLiquidity and previousDayHigh > close
    if na(shortLiquidity) or math.abs(shortLiquidity - close) < math.abs(shortLiquidity - previousDayHigh)
        shortLiquidity := previousDayHigh
if useAsianLiquidity and not na(asianHigh) and asianHigh > close
    if na(shortLiquidity) or math.abs(shortLiquidity - close) < math.abs(shortLiquidity - asianHigh)
        shortLiquidity := asianHigh

// ---- LIQUIDITY SWEEP ----
sweepLong  = not na(longLiquidity) and low < longLiquidity and close > longLiquidity
sweepShort = not na(shortLiquidity) and high > shortLiquidity and close < shortLiquidity

var float longSweepLow    = na
var float longSweepLevel  = na
var int   longSweepBar    = na
var float shortSweepHigh  = na
var float shortSweepLevel = na
var int   shortSweepBar   = na

if sweepLong
    longSweepLow := low
    longSweepLevel := longLiquidity
    longSweepBar := bar_index
if sweepShort
    shortSweepHigh := high
    shortSweepLevel := shortLiquidity
    shortSweepBar := bar_index

sweepValidityBars = input.int(5, "Sweep Validity (1m bars)", minval = 1, maxval = 20, group = groupLiq)
longSweepActive  = not na(longSweepBar) and bar_index - longSweepBar <= sweepValidityBars
shortSweepActive = not na(shortSweepBar) and bar_index - shortSweepBar <= sweepValidityBars

// ---- 1m RECLAIM / MOMENTUM ----
longMomentum  = ema9 > ema21 and close > vwap and rsi > 50
shortMomentum = ema9 < ema21 and close < vwap and rsi < 50

longReclaim  = longSweepActive and close > longSweepLevel and longMomentum and volumeOK and atrOK
shortReclaim = shortSweepActive and close < shortSweepLevel and shortMomentum and volumeOK and atrOK

// ---- STOP LOSS ----
stopBufferATR  = input.float(0.10, "SL Buffer ATR", minval = 0, maxval = 1, step = 0.05, group = groupExit)
minStopPercent = input.float(0.08, "Minimum SL (%)", minval = 0.01, maxval = 1, step = 0.01, group = groupExit)
maxStopPercent = input.float(0.30, "Maximum SL (%)", minval = 0.05, maxval = 2, step = 0.01, group = groupExit)

longStopCandidate  = longSweepLow - atr * stopBufferATR
shortStopCandidate = shortSweepHigh + atr * stopBufferATR

longStopDistance  = not na(longStopCandidate) ? close - longStopCandidate : na
shortStopDistance = not na(shortStopCandidate) ? shortStopCandidate - close : na
longStopPercent   = not na(longStopDistance) ? longStopDistance / close * 100 : na
shortStopPercent  = not na(shortStopDistance) ? shortStopDistance / close * 100 : na

longStopValid  = not na(longStopPercent) and longStopPercent >= minStopPercent and longStopPercent <= maxStopPercent
shortStopValid = not na(shortStopPercent) and shortStopPercent >= minStopPercent and shortStopPercent <= maxStopPercent

// ---- POSITION SIZE ----
longQtyRisk  = longStopDistance > 0 ? riskDollars / longStopDistance : na
shortQtyRisk = shortStopDistance > 0 ? riskDollars / shortStopDistance : na

maxNotional = accountSize * leverage
maxQty      = close > 0 ? maxNotional / close : na

longQty  = not na(longQtyRisk) ? math.min(longQtyRisk, maxQty) : na
shortQty = not na(shortQtyRisk) ? math.min(shortQtyRisk, maxQty) : na

// ---- DAILY RISK / TRADE LIMIT ----
newDay = ta.change(time("D")) != 0

var float dayStartingNetProfit = 0.0
var int   tradesToday = 0

if barstate.isfirst
    dayStartingNetProfit := strategy.netprofit
if newDay
    dayStartingNetProfit := strategy.netprofit
    tradesToday := 0

dailyPnL = strategy.netprofit - dayStartingNetProfit
dailyLossReached = dailyPnL <= -maxDailyLossDollars

if strategy.position_size != 0 and strategy.position_size[1] == 0
    tradesToday += 1

tradesLimitReached = tradesToday >= maxTradesPerDay

// ---- CONSECUTIVE LOSSES ----
var int consecutiveLosses = 0
var int previousClosedTrades = 0
var int lastLossBar = na

if strategy.closedtrades > previousClosedTrades
    tradeIndex = strategy.closedtrades - 1
    tradeProfit = strategy.closedtrades.profit(tradeIndex)
    if tradeProfit < 0
        consecutiveLosses += 1
        lastLossBar := bar_index
    else
        consecutiveLosses := 0
    previousClosedTrades := strategy.closedtrades

lossLimitReached = consecutiveLosses >= maxConsecutiveLosses
cooldownActive   = not na(lastLossBar) and bar_index - lastLossBar < cooldownBars

// ---- GLOBAL ENTRY PERMISSION ----
canTrade = strategy.position_size == 0 and not dailyLossReached and not tradesLimitReached and not lossLimitReached and not cooldownActive and sessionAllowed

// ---- ENTRY CONDITIONS ----
longEntry  = canTrade and longTrend and longReclaim and longStopValid
shortEntry = canTrade and shortTrend and shortReclaim and shortStopValid

// ---- TRADE MANAGEMENT VARIABLES ----
var float entryPrice = na
var float tradeStop  = na
var float tp1 = na
var float tp2 = na
var float tradeQty = na
var bool  tp1Hit = false
var bool  breakevenActive = false
var bool  isLongTrade = false

// ---- TAKE PROFIT SETTINGS ----
tp1RR              = input.float(1.0, "TP1 R Multiple", minval = 0.5, maxval = 5, step = 0.25, group = groupExit)
tp2RR              = input.float(2.0, "TP2 R Multiple", minval = 1, maxval = 10, step = 0.25, group = groupExit)
tp1Percent         = input.float(50, "TP1 Position %", minval = 10, maxval = 90, step = 5, group = groupExit)
moveToBreakeven    = input.bool(true, "Move SL To Breakeven After TP1", group = groupExit)
breakevenOffsetPercent = input.float(0.02, "Breakeven Offset (%)", minval = 0, maxval = 0.2, step = 0.01, group = groupExit)
useTrailing        = input.bool(false, "Trail Remaining Position", group = groupExit)
trailATRMultiplier = input.float(1.5, "Trailing ATR Multiplier", minval = 0.5, maxval = 5, step = 0.1, group = groupExit)

// ---- LONG ENTRY ----
if longEntry
    entryPrice := close
    tradeStop := longStopCandidate
    tradeQty := longQty
    riskPerUnit = entryPrice - tradeStop
    tp1 := entryPrice + riskPerUnit * tp1RR
    tp2 := entryPrice + riskPerUnit * tp2RR
    tp1Hit := false
    breakevenActive := false
    isLongTrade := true
    strategy.entry("LONG", strategy.long, qty = tradeQty)
    if showLabels
        label.new(bar_index, low, "LONG\nEntry: " + str.tostring(entryPrice, format.mintick) + "\nSL: " + str.tostring(tradeStop, format.mintick) + "\nTP1: " + str.tostring(tp1, format.mintick) + "\nTP2: " + str.tostring(tp2, format.mintick) + "\nQty: " + str.tostring(tradeQty, "#.#####") + "\nRisk: $" + str.tostring(riskDollars, "#.##"), style = label.style_label_up)
    longSweepBar := na
    longSweepLevel := na
    longSweepLow := na

// ---- SHORT ENTRY ----
if shortEntry
    entryPrice := close
    tradeStop := shortStopCandidate
    tradeQty := shortQty
    riskPerUnit = tradeStop - entryPrice
    tp1 := entryPrice - riskPerUnit * tp1RR
    tp2 := entryPrice - riskPerUnit * tp2RR
    tp1Hit := false
    breakevenActive := false
    isLongTrade := false
    strategy.entry("SHORT", strategy.short, qty = tradeQty)
    if showLabels
        label.new(bar_index, high, "SHORT\nEntry: " + str.tostring(entryPrice, format.mintick) + "\nSL: " + str.tostring(tradeStop, format.mintick) + "\nTP1: " + str.tostring(tp1, format.mintick) + "\nTP2: " + str.tostring(tp2, format.mintick) + "\nQty: " + str.tostring(tradeQty, "#.#####") + "\nRisk: $" + str.tostring(riskDollars, "#.##"), style = label.style_label_down)
    shortSweepBar := na
    shortSweepLevel := na
    shortSweepHigh := na

// ---- DETECT TP1 ----
if strategy.position_size > 0 and isLongTrade
    if high >= tp1
        tp1Hit := true
if strategy.position_size < 0 and not isLongTrade
    if low <= tp1
        tp1Hit := true

// ---- BREAKEVEN ----
if tp1Hit and moveToBreakeven
    breakevenActive := true

// ---- LONG POSITION MANAGEMENT ----
if strategy.position_size > 0
    currentStop = tradeStop
    if breakevenActive
        currentStop := entryPrice * (1 + breakevenOffsetPercent / 100)
    if useTrailing and tp1Hit
        trailingStop = close - atr * trailATRMultiplier
        currentStop := math.max(currentStop, trailingStop)
    strategy.exit("LONG TP1", "LONG", qty_percent = tp1Percent, stop = currentStop, limit = tp1)
    strategy.exit("LONG TP2", "LONG", qty_percent = 100 - tp1Percent, stop = currentStop, limit = tp2)

// ---- SHORT POSITION MANAGEMENT ----
if strategy.position_size < 0
    currentStop = tradeStop
    if breakevenActive
        currentStop := entryPrice * (1 - breakevenOffsetPercent / 100)
    if useTrailing and tp1Hit
        trailingStop = close + atr * trailATRMultiplier
        currentStop := math.min(currentStop, trailingStop)
    strategy.exit("SHORT TP1", "SHORT", qty_percent = tp1Percent, stop = currentStop, limit = tp1)
    strategy.exit("SHORT TP2", "SHORT", qty_percent = 100 - tp1Percent, stop = currentStop, limit = tp2)

// ---- RESET TRADE STATE ----
if strategy.position_size == 0 and strategy.position_size[1] != 0
    entryPrice := na
    tradeStop := na
    tp1 := na
    tp2 := na
    tradeQty := na
    tp1Hit := false
    breakevenActive := false

// ---- FEES ----
makerFee = input.float(0.020, "Maker Fee (%)", minval = 0, maxval = 1, step = 0.001, group = groupCost)
takerFee = input.float(0.055, "Taker Fee (%)", minval = 0, maxval = 1, step = 0.001, group = groupCost)
estimatedRoundTripFeePercent = takerFee * 2

// ---- VISUAL PLOTS ----
plot(showEMAs ? ema9 : na, title = "EMA 9")
plot(showEMAs ? ema21 : na, title = "EMA 21")
plot(showEMAs ? ema200 : na, title = "EMA 200")
plot(showVWAP ? vwap : na, title = "VWAP")
plot(showLiquidity ? swingHigh : na, title = "5m Swing High", style = plot.style_stepline)
plot(showLiquidity ? swingLow : na, title = "5m Swing Low", style = plot.style_stepline)
plot(showLiquidity ? previousDayHigh : na, title = "Previous Day High", style = plot.style_stepline)
plot(showLiquidity ? previousDayLow : na, title = "Previous Day Low", style = plot.style_stepline)
plot(showLiquidity ? asianHigh : na, title = "Asian High", style = plot.style_stepline)
plot(showLiquidity ? asianLow : na, title = "Asian Low", style = plot.style_stepline)

plotshape(sweepLong, title = "LONG LIQUIDITY SWEEP", style = shape.triangleup, location = location.belowbar, size = size.tiny, text = "SWEEP")
plotshape(sweepShort, title = "SHORT LIQUIDITY SWEEP", style = shape.triangledown, location = location.abovebar, size = size.tiny, text = "SWEEP")
plotshape(longEntry, title = "LONG ENTRY", style = shape.labelup, location = location.belowbar, size = size.small, text = "LONG")
plotshape(shortEntry, title = "SHORT ENTRY", style = shape.labeldown, location = location.abovebar, size = size.small, text = "SHORT")

plot(strategy.position_size != 0 ? entryPrice : na, title = "Entry", style = plot.style_linebr)
plot(strategy.position_size != 0 ? tradeStop : na, title = "Stop Loss", style = plot.style_linebr)
plot(strategy.position_size != 0 ? tp1 : na, title = "TP1", style = plot.style_linebr)
plot(strategy.position_size != 0 ? tp2 : na, title = "TP2", style = plot.style_linebr)

// ---- DASHBOARD ----
var table dashboard = table.new(position.top_right, 2, 16)

if barstate.islast and showDashboard
    trendText = longTrend ? "LONG" : shortTrend ? "SHORT" : "NEUTRAL"
    statusText = dailyLossReached ? "DAILY LOSS LOCK" : tradesLimitReached ? "TRADE LIMIT" : lossLimitReached ? "LOSS STREAK LOCK" : cooldownActive ? "COOLDOWN" : sessionAllowed ? "READY" : "OUT OF SESSION"
    winRate = strategy.closedtrades > 0 ? strategy.wintrades / strategy.closedtrades * 100 : 0
    profitFactor = strategy.grossloss != 0 ? strategy.grossprofit / math.abs(strategy.grossloss) : na

    table.cell(dashboard, 0, 0, "BTC SCALPER v2")
    table.cell(dashboard, 1, 0, "100x")
    table.cell(dashboard, 0, 1, "Account")
    table.cell(dashboard, 1, 1, "$" + str.tostring(accountSize, "#"))
    table.cell(dashboard, 0, 2, "Risk / Trade")
    table.cell(dashboard, 1, 2, "$" + str.tostring(riskDollars, "#.##"))
    table.cell(dashboard, 0, 3, "15m Trend")
    table.cell(dashboard, 1, 3, trendText)
    table.cell(dashboard, 0, 4, "15m RSI")
    table.cell(dashboard, 1, 4, str.tostring(rsi15, "#.##"))
    table.cell(dashboard, 0, 5, "1m RSI")
    table.cell(dashboard, 1, 5, str.tostring(rsi, "#.##"))
    table.cell(dashboard, 0, 6, "ATR %")
    table.cell(dashboard, 1, 6, str.tostring(atrPercent, "#.###"))
    table.cell(dashboard, 0, 7, "Trades Today")
    table.cell(dashboard, 1, 7, str.tostring(tradesToday))
    table.cell(dashboard, 0, 8, "Loss Streak")
    table.cell(dashboard, 1, 8, str.tostring(consecutiveLosses))
    table.cell(dashboard, 0, 9, "Daily P/L")
    table.cell(dashboard, 1, 9, "$" + str.tostring(dailyPnL, "#.##"))
    table.cell(dashboard, 0, 10, "Win Rate")
    table.cell(dashboard, 1, 10, str.tostring(winRate, "#.##") + "%")
    table.cell(dashboard, 0, 11, "Profit Factor")
    table.cell(dashboard, 1, 11, str.tostring(profitFactor, "#.##"))
    table.cell(dashboard, 0, 12, "Net Profit")
    table.cell(dashboard, 1, 12, "$" + str.tostring(strategy.netprofit, "#.##"))
    table.cell(dashboard, 0, 13, "Max Drawdown")
    table.cell(dashboard, 1, 13, "$" + str.tostring(strategy.max_drawdown, "#.##"))
    table.cell(dashboard, 0, 14, "Est. RT Fee")
    table.cell(dashboard, 1, 14, str.tostring(estimatedRoundTripFeePercent, "#.###") + "%")
    table.cell(dashboard, 0, 15, "STATUS")
    table.cell(dashboard, 1, 15, statusText)

// ---- ALERTS ----
alertcondition(longEntry, title = "BTC LONG", message = "BTCUSDT.P LONG liquidity sweep + reclaim confirmed")
alertcondition(shortEntry, title = "BTC SHORT", message = "BTCUSDT.P SHORT liquidity sweep + reclaim confirmed")
alertcondition(sweepLong, title = "BTC LONG SWEEP", message = "BTCUSDT.P bullish liquidity sweep detected")
alertcondition(sweepShort, title = "BTC SHORT SWEEP", message = "BTCUSDT.P bearish liquidity sweep detected")
```

## Backtest notes

- **Not yet run.** Nobody has put this through TradingView's Strategy
  Tester — treat every number in "Targets" above as the source
  conversation's own aspiration, not a verified result.
- Two real Pine v6 compile issues found in the source and fixed above,
  before this was usable at all:
  1. `strategy(...)` never set `margin_long`/`margin_short`, which default
     to 100 (no leverage) in Pine v6 — the 100x sizing math would have run
     against an unleveraged margin assumption, silently producing wrong
     backtest numbers rather than an error. Set to `1`/`1` (100/100),
     matching the leverage input's own default of 100x — same pattern
     `btc-high-risk.md`'s Pine script already uses for the same reason.
  2. `showLabels` was referenced inside the `LONG ENTRY`/`SHORT ENTRY`
     blocks but declared later in a `VISUALS` section further down the
     script — Pine evaluates top-to-bottom, so this would have failed to
     compile outright ("undeclared identifier"). Moved the whole `VISUALS`
     input block to the top, before first use.
- Run on the **1-minute chart**, BTCUSDT.P — this is a genuinely different
  timeframe from every other strategy in this repo (`btc-high-risk`,
  `ma-cross-demo` are both 1h). Pine's `request.security` warm-up for the
  15m/5m context needs enough 1m history loaded before the backtest's
  visible range starts, same lesson learned building `btc-high-risk`.
- The source conversation's own stated bar for trusting results: 500+
  closed trades, multiple distinct periods, not one optimized window.
  Given this is a 1-minute scalper, that trade count should accumulate
  much faster than `btc-high-risk`'s 1h swing trades did.

## Status

draft
