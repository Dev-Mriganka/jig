# The index

The SQLite copy of the records that the summary and the dashboards read: where
it is, what it holds, and how fast it answers. Back to the
[jig-lens overview](../README.md).

`~/.local/state/jig/lens/index.sqlite`, private to you (mode 0600, in a folder
with mode 0700), in WAL mode so that Grafana can read while a session writes.
Two sessions that write at once wait for each other for up to five seconds. The
summary opens it read-only.

Times are seconds since the epoch, because Grafana's SQLite data source reads
numbers as seconds.

## Tables

| Table | One row per | Columns |
|---|---|---|
| `call` | tool call | the record's fields under their own names (see [Records](../../jig-core/docs/records.md)) |
| `turn` | model turn | the model-turn record's fields under their own names |
| `imported` | record file | `file`, `bytes`, `skipped` and `at` |

- **`call`** keeps `facts` as JSON text.
- **`imported`:** `bytes` is how far the file has been read, `skipped` the lines
  that are not records, and `at` when it was last imported.

Read the facts with `json_extract(facts, '$.passed')`. A field that does not
apply is `NULL`. The tables are plain, not `STRICT`, so that Datasette can read
the file with whatever SQLite its Python was built with.

## SQL indexes

The summary and the dashboards start from a time range, a session or a ticket,
so `call` and `turn` each have an index for all three:

| Index | On |
|---|---|
| `call_time`, `turn_time` | `time` |
| `call_session`, `turn_session` | `session`, `time` |
| `call_ticket`, `turn_ticket` | `ticket`, `time` |

A query reads the rows of its scope and no others. Nothing starts with the
tool: the per-tool figures are made from the rows of a scope, and an index there
only made session and ticket scopes slower, because the query planner chose it
over their own.

An index made before an index was added gets it the next time it is opened for
writing, which `/lens` does first, so there is no rebuild. Delete the file and
`/lens rebuild` makes the same ones.

## How fast

A test builds an index of 100 000 calls and 20 000 turns over 90 days and times
every question on every kind of scope. The aim is under 200 ms for each.

- The slowest, the tools of all 100 000 calls at once, takes about 150 ms; the
  others take 50 ms or less.
- The usual `/lens` (a day, a session and a ticket as big as a quarter of all
  the calls) takes about a tenth of a second.
- The test fails at five times the aim, because a loaded machine is slower than
  a quiet one, and it prints every time.
- It also reads the plan of every statement from SQLite: none may read a whole
  table.
- The tools are counted in one pass over the rows, read as arrays of values,
  which is twice as fast as a `GROUP BY` for the counts and a second statement
  for the durations. SQLite has no percentile function, so the 95th percentile
  is made in the plugin.

## Other files

Grafana keeps its own data, such as your sign-in, in
`~/.local/state/jig/lens/grafana/`, and what it and Datasette print in
`~/.local/state/jig/lens/viewer.log`, which each start empties.

## Requirements

- `jig-core`, whose records this reads.
- Node 22.19 or later, as Jig requires, for `node:sqlite`.
