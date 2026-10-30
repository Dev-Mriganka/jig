# The summary

What `/lens` shows inside Pi, and how it reaches the screen. Back to the
[jig-lens overview](../README.md).

`/lens` shows three scopes, one after the other:
- **today,** the day on your own clock, not a UTC day;
- **this session;**
- **the ticket** that session is on now, when it is on one. That is the ticket
  on the session's latest record.

`/lens ticket KEY` shows one ticket over all time, `/lens session [id]` one
session (this one by default), and `/lens days N` the last N days, from 1 to 90.
A scope's text is up to five sections. A section with nothing to say is left
out, and a scope with nothing in it is one line.

## The sections

| Section | What it says |
|---|---|
| Cost | The total and the model turns, tokens in and out, and the cost by model and by agent role |
| Tools | Calls, failures and blocked calls; the tools that failed most; the slowest ones |
| Your time | Questions asked and how they were answered; the wait in total and its median |
| Blocked | Calls that never ran, grouped by who decided and why, with the tools stopped |
| Checks | The facts each tool reported on its latest call, such as test counts or a CI conclusion |

- **Cost:** tokens in are new input, cache reads and cache writes, with the share
  read from the cache. A single role called `main` is not listed.
- **Tools:** the five tools that failed most, with why (`tool`, `not-run`,
  `withheld`), and the five with the slowest 95th percentile of duration.
- **Your time:** answers are allowed, allowed for the session, declined or
  dismissed. The three tools that waited longest are listed.
- **Blocked:** who decided is `floor`, `rule`, `tool`, `table` or `unknown`; why
  is `denied`, `no-screen`, `invalid`, `declined`, `dismissed` or `internal`.
- **Checks:** each fact comes with how long ago it was reported.

- **A tool with several actions is several lines** (`git push`, `git status`),
  as in the dashboards.
- **Amounts carry their units:** `$1.23`, `4m 10s`, `12.3k tokens`.
- **A list that is longer than its limit** ends with a line that adds up the
  rest, such as `2 more models`.
- **A call that never ran** is counted under Tools as blocked, and listed
  under Blocked. A declined or dismissed question is counted under Your time
  too.
- **Names are cleaned.** A tool name, ticket or fact may come from other code,
  so control characters in it, such as a terminal escape, are shown as `?`.

## How it is shown

In a terminal the summary is an entry in the session, drawn in the chat with
the colours of your theme. The model never receives it: Pi keeps such entries
out of the conversation, and a test runs `/lens` in a real Pi session to see
that nothing of it reaches the model.

The code says why this way and not as a message, a status line or a panel
(`src/display.ts`).

Over RPC, which has no chat to draw in, it is a notification with each section
cut to its first line. With no screen at all (print and JSON modes) the summary
is not made.

An entry is data, so it is drawn again with the colours of the current theme,
and a resumed session shows it as it was. The text is cleaned again when it is
drawn, because a session file can be edited.

## The summary commands in detail

- **They import first,** so the figures include the run that has just ended.
  Lines that are not records, and record files that could not be read, are said
  in a warning after the summary.
- **A day is a local day,** from midnight to midnight on your clock, also on the
  days a clock changes (23 or 25 hours). `days 7` is today and the six days
  before it.
- **The session** is the one Pi says it is in. When Pi cannot say, `/lens` shows
  today alone, and `/lens session` asks for an id.
- **A ticket or session with no records** is one line:
  `Ticket PROJ-123, all time: no records`. An index with no records at all says
  `No records yet`, whatever was asked.
- **An index that cannot be read** is said, with `/lens rebuild` as the way to
  make it again.
- **The wrong arguments** (`/lens days 91`, `/lens ticket`) say what is wrong,
  then show the usage line, and do nothing else.

## Not shown yet

- cost while waiting for you, because a turn record has no duration;
- retries and repeated failures;
- runs blocked by failures that already exist on the main branch, which no
  tool reports yet;
- one ticket's calls and turns in order; the Session dashboard takes a session.
