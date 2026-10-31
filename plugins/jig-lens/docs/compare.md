# Comparing conditions

What `/lens compare` shows, and how to tag sessions so it can set two ways of working side by side. Back to the
[jig-lens overview](../README.md).

Set `JIG_CONDITION` before starting Pi, to a label such as `baseline` or `with-tool-x`. `jig-core` writes it on every
record (1 to 32 characters of `A-Za-z0-9._-`; anything else is left out), child agents inherit it, and the index keeps
it in the `condition` column of `call` and `turn`. `/lens compare [days N]` then groups the last N days (30 by default,
1 to 90, as in `/lens days`) by condition, one column for each.

## What counts as a session

- **A session** is a main session: its lines have the agent role `main`. A session without a condition is grouped as
  `(none)`.
- **Children** (agents started by `jig-agents`) count toward their parent session, not as sessions of their own.
- **Side calls** are short separate Pi processes, such as a judge model call, with a role other than `main` and no parent
  session. They are not sessions, but their cost belongs to their condition. Set `JIG_AGENT_ROLE` to a name other than
  `main` for such a process, and give it the same `JIG_CONDITION`.
- **The period** is a range of lines. A session that starts before it or goes on after it counts only for the lines inside.

## The table

| Row | What it says |
|---|---|
| sessions | How many main sessions the condition has |
| cost, input tokens, output tokens | Per session, as `median / mean`. Input is new input plus cache reads and writes |
| cost incl. side calls | The cost of the sessions and of the side calls, divided by the number of sessions |
| cache read | The share of input the cache supplied, per session, as `median / mean` |
| turns, tool calls | Per session, as `median / mean` |
| wall time | From the session's first to its last record, children included, as `median / mean` |
| failed calls, blocked calls | A share of all the condition's calls |
| side calls | How many processes, and what they cost together |

Under the table, the eight tools with the largest difference in calls per session between conditions are listed, named
as in the summary (`tool` or `tool action`).

## Reading it

- **Few sessions.** When any group has fewer than 5 sessions, a line above the table says "too few sessions to compare".
  The table is still shown.
- **No test of significance.** The last line says so and names the smallest group's session count. The medians and
  means are plain figures, and a gap between two small groups may be chance.
- **Screens.** In a terminal the table is a session entry the model never receives; over RPC it is a shortened
  notification (the notes, the top of the table and the last line); with no screen, nothing.

Back to the [jig-lens overview](../README.md).
