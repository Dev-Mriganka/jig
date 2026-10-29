# jig-lens: what happened, and what it cost

**Status: design, waiting for research.** Which local viewer to use is being
compared (see [Reuse](../../docs/reuse.md) and the research notes).

`jig-lens` reads `jig-core`'s records and shows them in a local dashboard on a
port of this machine. It writes nothing back, and nothing leaves the machine.

## What it shows

| View | Questions it answers |
|---|---|
| Cost | Cost per session, per ticket, per agent role (main, checker, scout) and per model; cache hit rate; cost while waiting for you |
| Tools | Calls and failures per tool and per error kind; retries and repeated failures; slow tools; calls refused by a rule |
| Your time | Questions asked per change, and how long calls waited for you |
| Checks and CI | Runs, results, durations, and runs blocked by failures that already exist on the main branch |
| One session or one ticket | Every call and turn in order, with decisions and results |

## Rules

- **Built on an existing viewer** over the records. Jig does not build its own
  charts.
- **Read-only:** the records belong to `jig-core`.
- **Separate from `jig-core`,** so the guard works without the dashboard.

## Viewer

*To be chosen from the research. Candidates include:*
- *Grafana over SQLite;*
- *Arize Phoenix;*
- *Langfuse;*
- *Datasette;*
- *plain SQLite with a small page.*

*Each is judged on local-only operation, setup effort, charts, and macOS and
Linux support.*
