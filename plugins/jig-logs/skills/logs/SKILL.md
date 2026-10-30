---
name: logs
description: How to search logs with the logs tool - start from an exact identifier in a narrow window, widen the window step by step, and read the lines that matter. Use whenever a ticket, an error report or a question needs evidence from the logs.
---

# Searching logs

The `logs` tool reads one search backend and never changes anything. A call names an `environment` from the
configuration, what to find, and a time window. The result is a header (window, status, hits found, fetched and shown,
buckets) and one line per hit.

## The order of work

1. **Pin down the event.** Get the environment, an approximate time and the best identifier: a trace or request id, an
   account or order id, or the exact text of an error. Ask for what is missing. For production, start from a confirmed
   environment, time and identifier.
2. **Search the strongest identifier first.** `phrase` finds an exact phrase in the message. `query` takes Lucene:
   `AND`, `OR`, `NOT`, wildcards (`timeout*`), quotes and fields (`level:ERROR AND payment`). Use `phrase` when one
   identifier will do.
3. **Start narrow.** `window: "30m"` or `"2h"` around the event, or `from` and `to` with a timezone (`to` is
   exclusive). Widen step by step (`1d`, then `7d`) instead of going straight to the widest. One call reads at most 7
   days; for older logs search consecutive slices.
4. **Follow the trail.** Take new identifiers from the lines you read, and search them the same way.

## Reading the lines

- `size` is how many hits are fetched (50 by default, at most 200); a page shows up to 20. `order: "asc"` fetches the
  oldest hits of the window, `"desc"` the newest. To see later events, use `desc` or narrow the window: raising `size`
  alone does not help.
- `match` keeps the hits that contain all its texts, `exclude` drops the ones that contain any. Both look only at the
  hits already fetched. To find a line by an identifier, put the identifier in `phrase`.
- `offset` pages through the hits; the line above them says which `offset` comes next.
- `around` shows each hit around a term, for a long message. `chars` sets how wide a line is, up to 4000.
- `{…}` or `[…]` is a JSON body cut for length, not hidden. Rerun with `chars: 4000`, or with `around` and a term from
  inside it.

## Reading the result

- `complete` means every part of the window was searched. `partial` means some parts were not: search the gaps again,
  narrower, and name them in your answer. `failed` means nothing was searched; the `Next:` line says what to change.
- "at least N hits" is a lower bound.
- No hits proves nothing about retention. Check the identifier, the environment and the window first. The availability
  line only says whether the window holds any documents at all.
- Production results are masked: personal values become tokens (`email#3fa9c1`) and identifiers are kept. Never tell
  the user something is unavailable because it is masked. The same value gets the same token all day, so you can follow
  it across searches.
- Quote the time of a line with any conclusion, so the user can check it.
