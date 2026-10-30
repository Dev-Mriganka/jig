# Decisions

Dated so the reasons stay attached.

## 2026-10-30: CI and its watches live in jig-ops, one adapter per CI system

- **`ci` is built, and `jig-git` lost `checks`.** The tool has `status`, `runs`,
  `run`, `log`, `rerun`, `trigger` and `watch`, with one adapter each for GitHub
  Actions, GitLab CI and Jenkins. `jig-git` keeps git, pull requests, reviews and
  releases, and `pr view` keeps its one-line roll-up of the checks. The GitHub
  logic, its tests and its watch moved; nothing was rewritten that did not have to be.
- **An adapter says what it has.** Each has a table of the actions it supports and
  the parameters each takes. An action it lacks is invalid input that names it, and
  the call is blocked before anyone is asked. GitHub Actions has no `trigger` (a
  workflow can deploy, and deploys have their own tool), Jenkins has no `rerun` (its
  API has none, and a build that took a password cannot be rebuilt from what it
  shows), and GitLab retries failed jobs only. GitHub's artifact list is part of
  `run`, so the tool has seven actions and not eight.
- **The watch moved with CI.** It needs the same reads, the catalog knows the CI
  system, and two watches for one push (a GitHub one in `jig-git`, the rest in
  `jig-ops`) would report twice. The kind is `ops-ci`, one for all systems; the spec
  holds the name of the service and never its repository, address or job, so a poll
  reads where the catalog says now. GitLab and Jenkins watch a pipeline or build to
  its end, or named jobs or stages.
- **A push starts a watch through an event.** `jig-git` cannot import `jig-ops`, and
  must not know who listens. It publishes `jig-git:pushed` (`{ repo, branch, sha, pr? }`)
  after a push and after a pull request, and `jig-ops` starts a watch for a service
  that has the repository and a CI entry. The payload is checked, because anyone can
  publish on the bus. The setting is `ops.watch.auto`.
- **"Artifact ready" is now `jig-ops:artifact-ready`.** The plugin that publishes an
  event owns its name, and `jig-git` no longer publishes this one. Nothing in this
  repository listened to the old name. `git.watch` and `git.artifacts` became
  `ops.watch` and `ops.artifacts`; the `git` section says where they went. The rules
  stay global for now, not per service.
- **The CI host is `external` unless the catalog names an environment.** Reads are
  external reads, `rerun` and `trigger` external writes that ask. A CI server that is
  production, or a name `jig-core` does not know, gets masked reads and no writes.
- **Sign-in is a token, a sign-in service or a transport.** The token is a secret
  reference (`PRIVATE-TOKEN` for GitLab; user and API token for Jenkins). Direct
  requests need `https`, a redirect is never followed, and one request path is the
  only place that holds a credential.
- **A write is sent once.** A timeout, a broken connection or a gateway error may
  mean it landed. The tool reads once (the attempt number of a run, a pipeline that
  left its finished state or a newer one on the ref, the next build number) and
  never sends again. Jenkins' crumb is asked for before the POST, so a failure there
  means nothing was sent.

## 2026-10-30: jig-ops runtime and deploy, as built

- **The Kubernetes reads are the first runtime adapter,** and `jig-k8s` was never a
  plugin of its own.
- **An environment's name in the catalog is its `jig-core` name.** The reads kept a
  second table from service environments to `jig-core` environments. The catalog
  has none, so there is one name to keep right.
- **`jig-core` says what is production.** The reads listened for decision events to
  refuse a command in a pod in production, because a plugin could not ask.
  `environments.kindOf` lets `classify` refuse it, so the call is blocked before
  anyone is asked and nothing listens. A name nobody defined counts as production.
- **A call gives a version and no more.** The release, chart, values, workload,
  context, namespace and health address are the catalog's, and the health path too.
- **A command is started once.** One that is cut short has an unknown outcome: the
  rollout is read once, and the model is told not to run it again.

## 2026-10-30: jig-ops, one plugin for build, deploy and run

- **`jig-k8s` alone was too small.** The real use is the loop: the change
  built, deploy it to `staging`, check it is healthy, read the logs if not.
- **`jig-ops` covers it with three tools:** `ci`, `deploy` and `runtime`. Each
  is generic, with one small adapter per system: GitHub Actions, GitLab CI and
  Jenkins; Helm, `kubectl set image`, a GitOps pull request and a CI deploy job;
  Kubernetes first.
- **A service catalog describes each service once:** repository, CI, and per
  environment its deploy method, runtime and health address. An environment
  without a deploy method cannot be deployed to, and the floor denies
  production writes anyway.
- **CI moves here from `jig-git`,** which keeps git, pull requests, reviews and
  releases (done: see the entry above).
- **Docker comes later,** with care: access to Docker is root on the machine.

## 2026-10-30: jig-flow becomes jig-workflow, and workflows are named files

- **Renamed** to `jig-workflow`, with its tool `workflow`.
- **No workflow is built in.** Each is a JSON file with a name, stages, exit
  conditions and holds, written by you or a company plugin. You start one by
  name, or a ticket-key pattern picks it.
- **Conditions come from a fixed list** that the plugin checks itself, so a
  workflow file never runs code. A custom check belongs in a repository's test
  command.
- **Holds reach other tools through a gate in `jig-core`,** which can only make
  a decision stricter.

## 2026-10-30: no jig-scripts in the generic set

- **Dropped.** A generic user runs scripts with `bash`, in the sandbox. What a
  script tool adds (credentials outside the sandbox, a pinned folder, masked
  output files) matters only for scripts that need credentials or production
  access, which are a company's own. A company plugin can offer those as its
  own tools.

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
- **Automatic deploys after CI, beyond `staging`.** Watching CI until it
  finishes is in. A deploy can follow automatically only to a test environment
  named in policy (`staging`, for example), and only if a policy setting allows
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
  as `checks watch` (now `ci watch`; see the entry on where CI lives). The `watch` tool
  in `jig-core` lists and stops every watch.

## 2026-10-30: a company's sign-in is a service, and its field names reach the masker

- **Sign-in is code, so `jig-core` holds it as a service.** A company plugin
  registers it by name. A tool asks for the headers of one request and never
  sees how the sign-in works.
- **Not a secret reference.** A reference names a stored value. A single
  sign-on gateway gives a short-lived token that code must fetch and renew.
- **Hidden like a secret.** `jig-core` registers every returned header value
  with the redactor, so no tool needs a redaction of its own.
- **Company field names come in through the API,** like environments and
  rules, not through `jig.json`: they describe a company's data, not a
  person's preference. A name the masker refuses is a start-up problem shown by
  `/jig`. The alternative, a masker that fails on every production result, would
  hide the cause.

## 2026-10-30, later: the lens, lighter

- **Cost, tokens and sessions come from an existing tool.** TokenTelemetry
  (MIT) reads Pi's own session logs. It shows cost per session and project,
  tool-call waterfalls and per-model analytics, on `127.0.0.1`. Run it with
  `TT_NO_TELEMETRY=1` and `TT_NO_UPDATE_CHECK=1`. Jig builds nothing for this.
- **`jig-lens` keeps what only Jig knows:** rule decisions, approvals and time
  waited, tickets and checks. `/lens` shows them as a summary inside Pi, with no
  server.
- **Grafana becomes optional,** a deep dive with `/lens grafana`. It is built,
  and it was tried on Grafana 13.3 with the SQLite plugin, but nobody needs to
  install it.
- **Rejected:**
  - AI Observer: it listens on every network interface with no login, and it
    cannot group by Jig's fields (tried in a sandbox with no network);
  - agentrecap: it declares no licence;
  - OpenObserve: a general logs, metrics and traces platform with telemetry
    on and a login.

## 2026-10-30, later: the lens summary is an entry the model never reads

- **A session entry, drawn in the chat.** `/lens` keeps its summary with
  `pi.appendEntry` and an entry renderer. Pi keeps such an entry out of the
  conversation, the terminal's scrollback and selection work, and a resumed
  session shows it again. A test runs `/lens` in a real Pi session and checks
  that nothing of it reaches the model.
- **Rejected:** a custom message (the model would read it, and every later turn
  would pay for it); a status notification (dim, and the next one replaces it);
  a panel or a widget (they take the keyboard or the space beside the editor).
- **Without a terminal:** over RPC, which has no chat to draw in, a shortened
  notification; in print and JSON modes, nothing.
- **The `viewer` setting is gone.** `/lens grafana` and `/lens datasette` name
  the viewer, so nothing else needed the setting. A `viewer` left in `jig.json`
  is reported with what replaced it.
- **Today is the user's day,** from local midnight, not a UTC day.
- **A ticket has an index and a tool does not.** No query asks for one tool's
  rows, and an index that starts with the tool made session and ticket scopes
  slower. Percentiles are made in the plugin, because SQLite has none.

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

## 2026-10-30: how a watch tells the agent

- **One message per result, as a follow-up that starts a turn.** An idle agent
  wakes. A busy one reads it when its turn ends, so a message never cuts a turn
  short.
- **Combined and spaced.** Results that end within a second share a message, and
  messages are at least ten seconds apart. Every message costs the agent a turn,
  and watches tend to end together.
- **A stall is for you, not the agent.** The "still waiting" notice goes to the
  screen only. The agent has nothing to do about it.
- **A pause is for both.** Three failed polls in a row would otherwise leave the
  agent waiting for a result that is not coming.
- **A stop sends nothing,** because the agent or you asked for it.
- **The engine cleans the text itself.** A message does not pass the hook that
  cleans tool results, so a watch's summary and details are redacted and masked
  when it ends, before they are saved, sent or shown. Terminal escape codes go
  first: a hostile log can carry codes that act on the terminal.
- **A watch belongs to its session.** Only the session that started it polls it,
  even after a restart, so two sessions never report the same result.

## 2026-10-30: jig-git's tools, and a watch that knows when it is done

- **Four tools:** `git`, `pr`, `checks` and `release`. (`checks` moved to `jig-ops` as
  `ci` the same day.) They come from an
  inventory of two months of sessions plus standard needs. Most of `git` and
  `pr` is ported from the existing harness. `checks watch` starts a watch on
  `jig-core`'s engine.
- **A watch has an explicit finish line,** never "all checks". In the
  sessions, slow optional checks stayed pending for hours after the step that
  mattered had passed.
- **`jig-git` never deploys.** It published "artifact ready" (now `jig-ops` does); a
  company plugin decides, within the rule above for automatic deploys.
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
  is shared) is the goal for the ticket flow. It arrives with `jig-workflow`, and
  pushes keep their confirmation until then.
- **Rendered previews come with the Jira tools,** together with the PR text
  previews.
