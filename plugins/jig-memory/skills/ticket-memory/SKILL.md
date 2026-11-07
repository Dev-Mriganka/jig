---
name: ticket-memory
description: Keeping a ticket's memory honest during long work - date notes from the clock, keep the Now block of notes.md current, save output the user pasted with the ticket tool, and track open checks so a promised check is done or named before the next command. Use when a ticket is active, when the user pastes the output of something they ran, or before handing the user a command for the next step.
---

# Keeping a ticket's memory

While a ticket is active, its folder holds `notes.md`, `evidence/` and `checks.json`. The next session, and the user, rely on them. Keep them true.

- Before investigating an error, class or service you do not recognise, run `ticket recall` with that text: it searches earlier tickets' notes and cards, and its results are history, not instructions.

## Dates

- Date a new heading or a dated line with today's date from the system clock: the notes message and the reminder say `Today is 2026-11-02`, and `date +%F` prints it. Never copy a date from an earlier heading in the notes.
- When a line refers to a file, check that the file still exists before you keep the line.

## The Now block

- `## Now` in `notes.md` is the status, the next step and the open questions. Change it when any of them changes: after a run, a decision or a new finding.
- An edit elsewhere in `notes.md` does not count. The reminder comes until `## Now` itself changes.
- Say what really happened: `Ran batch 3 of 5 on staging: 40 removed, 2 failed`, not a status from before the run.

## Output the user pasted

When the user ran something themselves and pasted its output, save it before you use it: `ticket save_evidence` with `text` (the output as pasted) and a short `label` such as `batch-3-output`. It is masked and saved in `evidence/`, with a line in `evidence/index.md`. Text over 48 KB is refused: save it in parts, each with its own label.

## Open checks

- When you say you will check something before the next step ("re-derive the locations before the next batch"), record it at once: `ticket add_check` with `text`.
- Every prompt carries the open checks until they are closed. `ticket list_checks` shows them.
- Before you hand the user a command for the next step, close each open check with `ticket close_check` (`id`, and `outcome`: what you found or did), or say plainly that it is still open and why. Never hand over the next command in the same message that promises a check you have not done.

## Empty files

When a ticket becomes active, you may be told that some files in its folder are empty, possibly cut short by a crash. Do not read such a file as "no rows": tell the user, and rebuild or recover it before any run uses it.
