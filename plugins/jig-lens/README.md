# jig-lens: what happened, and what it cost

**Status: design.** This README is the specification; there is no code yet.

`jig-lens` shows `jig-core`'s records in a local dashboard: cost, tool
failures, and time spent waiting for you. It never changes the records, and
nothing leaves the machine.

## What it shows

| View | Questions it answers |
|---|---|
| Cost | Cost per session, per ticket, per model and per agent role (the main agent, or a child such as a reviewer or a scout); cache hit rate; cost while waiting for you |
| Tools | Calls and failures per tool and per error kind; retries and repeated failures; slow tools; calls refused by a rule |
| Your time | Questions asked per change, and how long calls waited for you |
| Checks and CI | Runs, results, durations, and runs blocked by failures that already exist on the main branch |
| One session or one ticket | Every call and turn in order, with decisions and results |

Each view links one level down: from a day to its sessions, and from a session
to its calls.

## How it works

```text
 jig-core ── appends ──▶ records/<day>.jsonl     owned by jig-core: the source
                               │
                               │ jig-lens imports new lines
                               ▼
                         lens/index.sqlite        owned by jig-lens: a copy it can rebuild
                               │
                               │ read-only SQL
                               ▼
                         Grafana on 127.0.0.1     dashboards kept as files in this plugin
                               │
                               ▼
                         your browser
```

- **The record files stay the source.** Appending a line is the cheapest write
  that cannot break a tool call, and it keeps `jig-core` free of a database.
- **The index is a copy for querying.** Delete it and `/lens rebuild` makes it
  again, so its tables can change without migrations.
- **Imports are incremental and safe to repeat.** `jig-lens` remembers how far
  it has read each file and inserts by record id, so two sessions importing at
  once, or a rebuild, cannot count anything twice. Only complete lines are
  imported; a line still being written waits for the next import.
- **Imports run** at the end of each agent turn in any session that loads
  `jig-lens`, and when you open the dashboard.
- **Rows older than the records' retention** are removed at import.

## Index

`~/.local/state/jig/lens/index.sqlite`. Times are seconds since the epoch,
because Grafana's SQLite data source reads numbers as seconds.

| Table | One row per | Columns |
|---|---|---|
| `call` | tool call | the tool-call record's fields (see [`jig-core`](../jig-core/README.md#records)), with `facts` as JSON |
| `turn` | model turn | the model-turn record's fields |
| `imported` | record file | the file name and how many bytes have been read |

Grafana keeps its own data, such as your sign-in, in
`~/.local/state/jig/lens/grafana/`.

## Viewer

Chosen on 2026-10-30 from a comparison of LLM trace platforms, OpenTelemetry
backends and SQL dashboards. Each was judged on local-only operation, setup,
charts, licence, and Linux and macOS support.

| Viewer | Verdict | Why |
|---|---|---|
| Grafana OSS with the SQLite data source plugin | **use** | One local process and no containers. SQL panels, a variable for the session and the ticket, and links from a summary to its detail. The data source and dashboards load from files kept in this plugin |
| Datasette with `datasette-dashboards` | fallback | One Python process over the same index, with plainer charts |
| MLflow, through OpenTelemetry export | later | Trace waterfalls and LLM views, if they are wanted. An export from the index, not a second record |
| Arize Phoenix | skip | A richer trace view, but its licence (Elastic-2.0) is not an open-source one, and its dashboards are fixed |
| Langfuse, Opik, SigNoz, OpenLIT | skip | Three to seven containers each, with ClickHouse or Postgres: too heavy for one developer |

**Risk.** The SQLite data source is a small community plugin, last released in
May 2026. Its fit with the newest Grafana and with macOS is not verified yet.
If it fails, Datasette takes its place over the same index, with no change to
the import.

## Settings

Grafana runs with:
- `127.0.0.1` only, on the port from configuration;
- usage reports, update checks, plugin update checks and feedback links
  switched off (Grafana's `[analytics]` settings);
- its sign-in on and anonymous access off. On first start you sign in and set
  a new admin password; do not skip that step. Jig never stores it;
- one data source, which opens only the index, read-only.

Installing the plugin contacts grafana.com once. After that, nothing leaves
the machine.

Datasette, as the fallback, runs with arbitrary SQL turned off
(`allow_sql: false`), so the page runs only the queries kept in this plugin.

**Why the sign-in stays on.** The agent's shell can reach `127.0.0.1`; that is
also why approvals never happen in the browser. Anyone who can query a Grafana
data source can send it any SQL, and SQLite's `ATTACH` opens other database
files that Grafana can read. Open access would let the agent read, through
Grafana, files that the sandbox hides from it.

## Commands

| Command | What it does |
|---|---|
| `/lens` | Imports new lines, starts the viewer if it is not running, and opens the dashboard |
| `/lens rebuild` | Deletes the index and imports every record file again |
| `/lens status` | The viewer's address and state, the index size, and the time of the last import |

## Configure

In `~/.pi/agent/jig.json`, under `lens`. All fields are optional.

| Field | Default | Meaning |
|---|---|---|
| `viewer` | `grafana` | `grafana` or `datasette` |
| `port` | 3300 | The viewer's port on `127.0.0.1` |

## Rules

- **Read-only over the records.** They belong to `jig-core`.
- **Separate from `jig-core`,** so the guard works without the dashboard.
- **No charts of our own.** An existing viewer draws them.

## Prerequisites

- `jig-core`, whose records this reads.
- Node 22.13 or later, for `node:sqlite`.
- Grafana OSS and its `frser-sqlite-datasource` plugin, installed by you: a
  package manager on Linux, Homebrew on macOS. Jig does not bundle them.
- For the fallback: Datasette and `datasette-dashboards`, through `pip`.

## Later

- **OpenTelemetry export to MLflow,** for trace waterfalls. Each call becomes
  an `execute_tool` span and each turn a `chat` span, grouped by session.

## Layout (planned)

```text
jig-lens/
  src/          import (records to index), commands, starting the viewer
  viewer/
    grafana/    provisioning for the data source and dashboards, one JSON file per dashboard
    datasette/  metadata and canned queries for the fallback
  test/         import against sample record files
```
