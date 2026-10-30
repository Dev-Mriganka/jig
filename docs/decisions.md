# Decisions

Dated so the reasons stay attached.

## 2026-10-30: jig-theme, the look, built on Pi's own themes

- **One plugin for how Pi looks:** palettes, the footer, and the answer colour.
  It has no tools, so the model never sees it.
- **Palettes are Pi theme files,** not colours painted by an extension. Pi's
  `/settings`, its HTML export and its hot reload then work with them, and they
  work without the rest of Jig.
- **A palette is about fifteen named colours and one shared role map.** Adding a
  palette, or your own, means choosing those colours, not filling every role.
  A palette can still set single roles where the map is not right for it.
- **Your palettes are written into Pi's themes folder.** Pi finds a theme there
  by name, even one written after it started, and reloads the one in use when
  its file changes. `jig-theme` records a hash of each file it writes, and
  writes or deletes only a file whose hash still matches, so a file you changed
  by hand is never overwritten.
- **Other plugins add footer parts on Pi's event bus,** `jig-theme:segment`. A
  plugin then does not depend on `jig-theme`, and nothing breaks without it.
- **The usage history goes to `jig-lens`** as `/lens usage`, because it is about
  cost, which is what `jig-lens` shows.
- **Company parts stay in the company plugin:** a model spend in the footer, and
  names for the models its provider records.

## 2026-10-30: reviews are approved in their page, and a passkey makes that unforgeable

- **You chose to approve a review in its page.** A review is long, it waits for
  you across many turns, and the page is where you read it. Sending you back to Pi
  to type `y` after reading there was friction with no extra safety, once the
  approval itself cannot be forged.
- **The old rule did not go.** [Approvals](approvals.md) say you approve inside the
  waiting call, because a web endpoint is reachable from the agent's shell. That
  reason still holds for a button. What changed is the endpoint: it checks a
  WebAuthn signature over a fresh challenge, made by a key on your device after the
  device checked you. The agent cannot make it, so the endpoint's address stops
  mattering. A stolen cookie can comment as you; it cannot approve.
- **A passkey, written on `node:crypto`.** No WebAuthn library: the checks are a
  few hundred lines that can be read whole (a small CBOR decoder, the COSE key, the
  challenge, origin, relying party id hash, user presence and verification, the
  signature and the counter). Keys are ES256 and RS256, which is what Windows Hello,
  Touch ID and security keys make. Attestation is `none`: a key is trusted because
  you confirmed its fingerprint, not because of its make.
- **Registering a key is an approval in Pi.** Before it is stored, Pi shows the
  SHA-256 fingerprint and asks `y`. Removing one asks in Pi too. So a key cannot be
  added from the page alone.
- **The store is in Pi's agent folder.** The agent's shell does not write it; the
  review records live beside it, so a record that says "approved" was written by
  this plugin and not by a command. If the agent could write the folder, it could
  register its own key, so the folder's protection is the real guard.
- **A tampered file is not trusted, and not overwritten.** A key whose fingerprint
  is not its key's was never confirmed and is ignored; a file that cannot be read,
  is loose or is not ours trusts no key and is left for you to look at. Approval then
  falls back to the page and a `y` in Pi.
- **The fallback is the old rule.** With no passkey, or a browser without one, the
  page marks the review "approved in page" and Pi asks `y`. The record says which
  way it was given (`passkey` or `page-and-pi`), so a later gate can ask for the
  stronger one.
- **The page is opened at `localhost`.** A passkey's relying party id cannot be an
  IP address, so the link says `localhost` while the server still listens on
  `127.0.0.1` alone.
- **Approval is bound to the diff.** The challenge names the review and its diff as
  you saw it; if a new round arrived since, the approval is refused.

## 2026-10-30: jig-mongo is built on the official driver, with the walk of a pipeline as one of two locks

- **The driver is `mongodb` 7.7.0, pinned exactly (Apache-2.0).** It is the supported way to speak to MongoDB: its wire protocol,
  authentication, TLS and server selection are not worth rewriting, and `mongosh` would add a second language that runs code. It is the
  only runtime dependency besides `yaml`, it is loaded on the first call, so a session that never reads MongoDB does not pay for it, and
  only `driver.ts` imports it. Its own dependencies are `bson`, `@mongodb-js/saslprep` and `mongodb-connection-string-url`.
- **The tool talks to a seam, not to the driver.** `Backend` is what the tool asks of a database, and `adaptClient` turns it into driver
  calls. The tool is tested with a fake of the seam, the adapter with a fake client, and one optional test uses a real server when
  `JIG_TEST_MONGO_URI` is set.
- **Results are relaxed Extended JSON.** A plain string for an id would not match an ObjectId in the next filter, so the model would
  waste calls on it. Binary data and code are shown as a note. A 64-bit integer that JSON cannot hold keeps its type: the driver's own
  relaxed form loses digits there.
- **A pipeline is walked, and with an allow list it is also reshaped.** The walk refuses a reference to a denied or unlisted field in
  every stage and sub-pipeline. It is a static check of a language with many corners, so with an allow list a projection of the allowed
  fields is put in front of every stage and sub-pipeline: a corner the walk missed then reads nothing that is not listed.
  `$objectToArray` is refused because it turns field names into values; `$graphLookup` is refused with an allow list because it cannot
  be limited. A name that looks denied is refused even as the name of a new field, which is a small cost for a rule that is easy to state.
- **A write reports counts, so a write names no denied field.** `modifiedCount` of `{"$set": {"password": "x"}}` would tell the agent
  whether the value equals "x". Filters, updates and documents are checked like reads.
- **The preview's count is the guard.** The count is read just before the preview and again when the call runs, and the fingerprint
  covers it. `limit` is the cap of a write of many (1000 by default, at most 2000), so one parameter keeps the meaning "how many".
  Upserts and array filters are not supported yet: an upsert is a write whose count is zero.
- **A write is sent once.** The driver's `retryWrites` is off, and a lost reply is answered by one read, never by sending again.
- **The SSH route is arguments only.** `-F /dev/null` leaves out ssh configuration that the agent's shell could have written, the host
  and user are checked to be plain words, and the key lives in a private file only until ssh has signed in. A forward reaches one host,
  so the address must be one `host:port`; the certificate is still checked against the database's own name.
- **A connection is never named `local` or `external`.** Writes to those are not asked about as writes to a test environment are.

## 2026-10-30: jig-mongo is a complete MongoDB tool; no SQL tool for now

- **Complete:** exploring, indexes, query plans, the full aggregation pipeline,
  and writes. `jig-core` keeps it safe: reads run, writes to a test environment
  ask with a preview that counts the documents, and production writes are
  denied.
- **Access by list:** a deny list in test environments, and an allow list in
  production, which fails closed. The lists reach fields, so an aggregation
  that names a denied field is refused before it runs. System databases and
  credential-like fields are always denied.
- **No generic SQL tool yet.** The SQL databases met so far are a company's own
  reporting stores, read through its own scripts. A `sql` tool waits until one
  is needed at more than one job.

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

## 2026-10-30: jig-api part 2: Bruno, OpenAPI and the Postman cloud, and the first dependency

- **`yaml` is the repository's first runtime dependency (2.9.1, pinned exactly).** Bruno's default format is YAML and OpenAPI specs
  are mostly YAML, and a YAML parser is not something to write: anchors, block scalars, flow styles and several ways to quote.
  `yaml` (eemeli/yaml) was chosen over writing one, and over a parser that comes with a larger tree, because:
  - it is ISC-licensed and has no dependencies of its own, so the lock file gains one package;
  - it parses and never evaluates: no custom tag runs code, aliases are capped, duplicate keys are an error;
  - it reports a code and a position for a mistake, so a message can name the line and never quote it (a line of an environment
    may hold a secret);
  - it ships its own types.
  It is used only to parse. Nothing is `eval`ed.
- **Bruno's `.bru` language is read by a small reader of our own.** Its parser comes with a grammar library and a utility library, which
  is more than a line format of a few block kinds needs, and the reader has to keep a secret's value out of every message anyway.
  The format is documented in Bruno's pages and its own readers, which `docs/not-verified.md` lists.
- **No `.env` file is ever read.** Bruno reads `{{process.env.NAME}}` from one. Here it is a secret named `process.env.NAME`, filled
  from `api.secrets` like any other, so the file that is easiest to commit by mistake is never opened.
- **OpenAPI is opt-in, per environment, and its hosts are configured.** A spec lists what an API can do, not what a team chose to
  run, and its servers rarely match environment names. So it runs only in the environments listed in its own configuration, against
  the servers that configuration maps to them, and in production only for reads and only with `allowProductionReads`. Writes in
  production stay denied by the floor.
- **A credential in a spec is a slot, never a value.** Each security scheme becomes secret variables named for it, filled from
  `api.secrets` or by the company's sign-in. A token address on a host that is not one of the spec's servers is refused, so a client's
  secret is not sent to a host the environment does not have.
- **Optional parameters are left out, not blanked.** A parameter or body property the spec does not require is sent only when the
  agent gives it, so a missing filter does not become an empty one.
- **Postman's cloud is fetched by a command the person types.** `/api refresh` fetches to a local copy, and reading stays
  synchronous, because a call is classified before it runs. The fetch is an ordinary request of the sending engine, so a transport
  carries it and the key is read by `jig-core` when it is sent. The copy omits the values of secret variables and is private to the
  user. A collection access key, which goes in the address, is not used.

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

## 2026-10-30: jig-http becomes jig-api, and runs saved requests

- **Renamed** from `jig-http` to `jig-api`, and its tool from `http` to `api`. The plugin still sends
  HTTP, but the agent no longer types a host, a path or a header: it runs a request the team already
  saved, by name, and fills its variables.
- **Why.** Teams keep their requests in Postman, Bruno, `.http` files or an OpenAPI spec. A request
  written by a model is a request to get wrong, and an environment to reach by accident. A saved
  request cannot be mistyped, and its environment decides its host.
- **What carries over:** the sending engine and its tests: sign-in, OAuth, transports, previews that
  are tied to what is sent, and the rule that a lost reply is never resent.
- **What changed:**
  - the configuration is `api`: collections, the mapping of their environment names to `jig-core`'s,
    secret references, requests that read although their method does not, and the environments where
    an ad-hoc `call` is allowed;
  - a call's action is the request's name, so a rule can name one request;
  - a folder runs as its strictest request.
- **Requests are sent by the tool, scripts never run.** Running an API client's own CLI would run its
  scripts with the agent's variables. A request that needs a pre-request script is refused by name;
  most need none.
- **Hosts are pinned per environment,** and link-local and cloud-metadata addresses are never called.
  The environment decides where a request goes, so a saved request that names another environment's
  host cannot reach it. The agent can fill a variable, never the host.
- **Secrets come from references only.** A variable the format marks secret needs a reference in
  `api.secrets`. A plain value for it in an export is refused, with a warning that names the file,
  because exports travel by email and git.
- **Ad-hoc `call` is opt-in and never production,** asked of `jig-core`, so a company's own name for
  production counts.
- **Two parts.** Part 1 is Postman files and `.http` folders. Part 2 is Bruno, OpenAPI and a Postman
  workspace, one adapter each behind the same interface.

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
