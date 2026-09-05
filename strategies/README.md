# Strategies

Each file here documents one trading strategy end to end — thesis, entry/exit
rules, risk management, and a working TradingView Pine Script v6 backtest —
independent of whatever is or isn't implemented in `apps/engine`.

The point of keeping this separate from the engine: Pine Script is fast to
iterate and backtest in, so a strategy idea gets proven out here *before* the
work of porting it into `apps/engine/src/strategy/` (real money/paper
capital, real risk management) is justified. Not every strategy documented
here needs to exist in the engine, and not every engine strategy needs to
have started here — but when one does move from prototype to live, update
its `Status` field and cross-reference the engine file, so it's easy to tell
which documented strategies are just ideas versus ones actually trading.

## Managing strategies

Use the matching skills rather than hand-editing when possible, so the
format stays consistent:

- **create-strategy** — interviews you about a new strategy (entry, stop
  loss, take profit, exit rules, position sizing, targets) and writes the
  `.md` file, including the Pine v6 code.
- **update-strategy** — changes an existing strategy's rules and keeps the
  analysis and the Pine code in sync.
- **delete-strategy** — removes one, with confirmation first.

## File format

One markdown file per strategy, named `<slug>.md` (e.g. `ma-cross-demo.md`).
Each follows the same section order: Overview, Entry logic, Stop loss logic,
Take profit logic, Exit rules, Position sizing, Targets, Parameters, Pine
Script v6, Backtest notes, Status. See `ma-cross-demo.md` for a filled-in
example — it documents the actual strategy currently running in
`apps/engine` (see `strategy/movingAverageCross.ts`), including its real gap
(no stop loss or take profit at all), rather than a hypothetical one.

## Status field

- `draft` — written, not yet backtested on TradingView.
- `backtested` — run through TradingView's Strategy Tester, results reviewed.
- `promoted` — ported into `apps/engine/src/strategy/`; note which file.
- `retired` — no longer in use; kept for reference.
