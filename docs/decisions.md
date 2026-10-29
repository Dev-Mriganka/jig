# Decisions

Dated so the reasons stay attached.

## 2026-10-30: one tool manager over every tool

`jig-core` governs every tool call through Pi's hooks: Pi's own tools, Jig's,
and other packages'. This replaces an earlier design in which each tool carried
its own safety pipeline.

**Kept**
- **Rules:** per tool and per environment, in configuration.
- **Approval screens:** they grow from yes or no, to review screens, to
  multi-question forms.
- **Secret backends:** configurable, with `pass` first.
- **Docs first:** each plugin's README is its specification.
- **Reuse over building,** when an existing package is better.

**Changed**
- **The floor.** Configuration can make anything stricter but never lower it:
  production writes stay denied, production results stay masked, and
  credentials stay hidden from `bash`. See [Permissions](permissions.md).
- **`bash`.** It is protected by the sandbox. Command rules are a convenience,
  not the protection, because a shell string can reach anything.
- **Masking and secrets.** Jig's own tools mask their results and fetch secrets
  themselves; the tool manager is the backstop for every other tool.

**Rejected**
- **A homemade password manager.** It is a liability. Every platform has a
  store with a command-line interface (see [Secrets](secrets.md)).
- **Approve buttons in a browser.** The agent could forge them. The browser
  shows; `y` inside the waiting call approves (see [Approvals](approvals.md)).
- **The database and dashboard inside `jig-core`.** They are a separate
  plugin, `jig-lens`: `jig-core` writes records and `jig-lens` reads them.
- **A homemade charts interface.** `jig-lens` uses an existing local viewer.
- **Automatic deploys after CI beyond the first shared test environment.**
  Watching CI until it finishes is in. A deploy can follow automatically only
  to a test environment named in policy, and only if a policy setting allows
  it; never to production.

## 2026-10-30: jig-core is our own code, and it runs the watches

- **Our own code, not built on `@gotgenes/pi-permission-system`.** Jig borrows
  its patterns (see [Reuse](reuse.md)). It is not a dependency because:
  - environments are that package's stated non-goal;
  - it judges another package's tools by name only;
  - it releases a new major version almost every month.
- **The watch engine lives in `jig-core`.** It covers polling, finish lines,
  saving, resuming and notices. Plugins share code only through `jig-core`, and
  a company plugin needs the same engine for its own CI and deploys.
- **Who starts and who stops.** A plugin starts a watch from its own tool, such
  as `checks watch`. The `watch` tool in `jig-core` lists and stops every watch.

## 2026-10-30: the lens reads a copy of the records

- **The records stay JSON lines,** written only by `jig-core`. Appending a line
  cannot break a tool call, and `jig-core` needs no database.
- **`jig-lens` keeps a SQLite index** of them that it can always rebuild, and
  the viewer reads only that index.
- **The viewer is Grafana with a SQLite data source:** one local process, SQL
  panels, and dashboards kept as files. Datasette is the fallback over the same
  index.
- **Grafana's sign-in stays on.** The agent's shell can reach `127.0.0.1`, and
  a Grafana data source runs any SQL it is sent.
- **Rejected: an LLM trace platform as the store.** Langfuse and Opik need
  several containers; Phoenix's licence is not open source, and its dashboards
  are fixed. An export to MLflow can come later, as a copy.

## 2026-10-30: jig-git's tools, and a watch that knows when it is done

- **Four tools:** `git`, `pr`, `checks` and `release`. They come from an
  inventory of two months of sessions plus standard needs. Most of `git` and
  `pr` is ported from the existing harness. `checks watch` starts a watch on
  `jig-core`'s engine.
- **A watch has an explicit finish line,** never "all checks". In the
  sessions, slow optional checks stayed pending for hours after the step that
  mattered had passed.
- **`jig-git` never deploys.** It publishes "artifact ready"; a company plugin
  decides, within the rule above for automatic deploys.
- **Left out:** starting workflows by hand, a raw API tool, approving pull
  requests, and destructive commands such as `reset --hard`.

## 2026-10-30: built clean, beside the existing harness

- **The existing harness is not modified for Jig work.** Its one security fix
  made during this design stays: its code-review tool no longer gives the
  agent the review page's link with its secret.
- **Jig is tried in its own Pi profile** (`PI_CODING_AGENT_DIR`) on scratch
  work. That profile borrows the existing harness's sandbox, unchanged, through
  Pi's package filter.
- **Swapping Jig plugins into daily use** is decided later, plugin by plugin.

## Earlier decisions that still hold (2026-10-29)

- **Pi only.** No Claude Code plugin.
- **Two repositories.** This public, generic `jig`, and a private company
  plugin kept at the company.
- **One approval per change** (after tests and checks, before the pull request
  is shared) is the goal for the ticket flow. It arrives with `jig-flow`, and
  pushes keep their confirmation until then.
- **Rendered previews come with the Jira tools,** together with the PR text
  previews.
