---
name: delete-strategy
description: Removes a documented strategy file from strategies/. Use this whenever the user asks to delete, remove, or get rid of a strategy that has a file in strategies/. Always confirm which strategy and get explicit confirmation before deleting — this is a destructive action on a file that may represent real analysis work.
---

# Delete Strategy

Removes one `strategies/<slug>.md` file. Deleting documentation is cheap to
redo if the strategy was trivial, but expensive if it captured real analysis
— confirm before acting rather than treating this as routine.

## Steps

1. **Identify the target.** If the user named the strategy clearly and
   `strategies/<slug>.md` exists, confirm that's the one. If it's ambiguous,
   list `strategies/*.md` and ask which one.
2. **Check its status.** Read the file's `Status` field. If it's `promoted`
   (already ported into `apps/engine/src/strategy/`), say so explicitly and
   ask whether the user also wants the engine code removed — that's a
   separate, more consequential action this skill does not do on its own.
3. **Confirm before deleting.** State the file path and ask for explicit
   confirmation — don't delete on the first mention. This matches how
   destructive actions are handled elsewhere in this project (e.g. the
   dashboard's kill-switch button requires a second confirming click rather
   than a single click).
4. **Delete the file** once confirmed.
5. **Report what happened.** Confirm the file is gone, and mention that if
   this repo is a git checkout with the file previously committed, the
   content is still recoverable from git history (`git log -- strategies/`)
   even though the working copy is gone — don't imply it's unrecoverable if
   it isn't.

## What this skill does not do

It does not touch `apps/engine/src/strategy/` even if the strategy was
`promoted` — removing a live or paper strategy from the running engine is a
separate, more consequential decision (it may have open positions, capital
allocated, or trade history) that deserves its own explicit conversation,
not a side effect of deleting a markdown file.
