# Grafana and Datasette

The two optional viewers over the index, why these, and what they need. Back to
the [jig-lens overview](../README.md).

**The everyday view is `/lens` inside Pi:** a summary with no server and no
install. Grafana is an optional deep dive (`/lens grafana`) for when charts and
drill-down are wanted, and Datasette (`/lens datasette`) takes its place where
Grafana cannot be installed. How each is run is in
[Viewer settings](viewer-settings.md), and what `/lens grafana` does step by step
is in [Starting Grafana](starting-grafana.md).

## The dashboards

Five dashboards, in a Grafana folder named Jig. A day is a UTC day, as in the
record files.

| Dashboard | Questions it answers |
|---|---|
| Overview | Cost per day, per model, per agent role (the main agent, or a child such as a reviewer or a scout), per ticket and per session; cache hit rate; calls and errors per day |
| Tools | Calls and failures per tool and per error kind; the slowest tools; calls refused by a rule; recent failures |
| Your time | Questions asked per tool and per ticket, and how long calls waited for you |
| Checks | Calls that carry facts: test counts and CI conclusions, and every fact name in use |
| Session | Every call and turn of one session in order, with decisions and results |

Tables link one level down: click a session in a table, and the Session
dashboard opens with that session chosen. To see one day's sessions, select the
day in the time picker; the Overview's session table then lists that day's.

Datasette shows the queries kept in this plugin as tables. Charts with
`datasette-dashboards` come later.

## Which viewer

Chosen on 2026-10-30 from a comparison of LLM trace platforms, OpenTelemetry
backends, SQL dashboards and tools built for coding agents. Each was judged on
local-only operation, setup, charts, licence, and Linux and macOS support.

| Viewer | Verdict | Why |
|---|---|---|
| Grafana OSS with the SQLite data source plugin | **optional deep dive** | One local process and no containers. SQL panels, a variable for the session and the ticket, and links from a summary to its detail. The data source and dashboards load from files kept in this plugin |
| Datasette | fallback | One Python process over the same index. The queries kept in this plugin show as tables; charts with `datasette-dashboards` come later |
| MLflow, through OpenTelemetry export | later | Trace waterfalls and LLM views, if they are wanted. An export from the index, not a second record |
| Arize Phoenix | skip | A richer trace view, but its licence (Elastic-2.0) is not an open-source one, and its dashboards are fixed |
| Langfuse, Opik, SigNoz, OpenLIT | skip | Three to seven containers each, with ClickHouse or Postgres: too heavy for one developer |

**Risk.** The SQLite data source is a small community plugin, last released in
May 2026. It was tried with Grafana 13.3 and plugin 4.0.6 on Linux: the index
opens read-only in WAL mode and every dashboard query runs. macOS is not tried
yet. If the plugin fails, Datasette takes its place over the same index, with
no change to the import.

## What to install

Jig does not bundle either viewer. Both are optional: `/lens` needs neither.

- **For `/lens grafana`:** Grafana OSS and its `frser-sqlite-datasource` plugin,
  installed by you: a package manager on Linux, Homebrew on macOS.
  `grafana cli plugins install frser-sqlite-datasource` needs the folder Grafana
  loads plugins from: usually `sudo` for a package install, or
  `--pluginsDir <home>/data/plugins` for an unpacked download. Restart Grafana
  after it.
- **For `/lens datasette`:** Datasette, through `pip`.
