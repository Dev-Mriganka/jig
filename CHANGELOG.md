# Changelog

What changed in Jig, newest first. Pi shows the entries newer than the version you had, once, after an update.

## [Unreleased]

### Added

- A ticket with notes is searchable before it is closed: `jig-memory` derives a bounded entry from its `## Now` and
  `## Decisions`, searches it with recall, and labels it as from notes with its date and that it may be out of date.
  Automatic recall needs a shared name, ID or error and takes at most one derived entry; `/ticket recall` and the
  `ticket` tool's new read-only `recall` action also take a rare word and always search notes, with written cards first.
  `memory.recall.notes` turns on automatic recall only; `memory.recall.enabled: false` stops all recall. The derived
  entries are off by default until the hand-label numbers clear the bar. `scripts/recall-eval.mjs` measures a folder
  without printing content, takes hand labels with `--labels`, and scores top 3 independently of the display cap.
  Automatic and agent searches are recorded for `jig-lens` with entry and query counts, and no text. CRLF notes, symlinks
  and FIFOs are handled safely, and recalled text is stripped of control characters.

### Changed

- `logs` stops a search at 80 seconds and returns what it found, with the windows it could not search named, instead of the
  bare “This operation was aborted”; two real searches took 108 and 120 seconds, so they now return a partial result with a
  line saying to narrow the window or the environment.

- `pr create` fails on a missing body or a repository the configured `gh` account cannot see before it asks, so an approval
  is not spent on a call that cannot work; `repo` accepts `owner/name` when one workspace folder has that origin; `git log`
  accepts `pickaxe` (`-S`) and the prompt names `log`, `show` and `blame`.

### Fixed

- A tool's own refusal is recorded as `blocked`/`refused`, not a tool error, so `/lens` counts guards apart from failures.
  `jig-mongo`'s scan, partly-allowed-field and several-connections refusals and `jig-git`'s protected-branch refusals use it;
  what the model sees is unchanged. A tunnel whose password store is locked now says so and points at
  `secrets.pass.unlockAtStart`.

## [0.4.3] - 2026-11-06

### Added

- `ci services` lists the ops catalog's services that have a CI entry, one line each with its system; an unknown service
  name now suggests the nearest configured one.
- `jira create` sends one value as a one-item list when the create screen's schema says the field is an array, and says so
  in the preview.
- `git.accounts` maps a repository's remote to the `gh` account its GitHub calls use, so a work repository and a personal one
  keep working while either account is active. Jig reads that account's token for the one call and never switches the active
  account or stores the token ([jig-git](plugins/jig-git/docs/configuration.md)).
- `mongo access` lists an environment's configured rules without opening a database connection, so it works while
  MongoDB is down; the list keeps a field rule's scope such as `*.notes` and names the always-denied system databases,
  system collections and credential-like fields.

### Changed

- `tool_search` runs without asking: it only loads a tool definition, and the permission gate still decides each real
  call.
- Jig tool calls and results in Pi's timeline are one line each, with the full text on Pi's expand key; a tool can give
  its own call line. Masked text stays masked in both views.
- Long approvals open in a floating window, falling back to the inline screen on a terminal too small for it or when
  the overlay cannot open.
- A browser code review keeps one line and a `review: waiting for you` or `review: agent working` status in Pi; the diff
  stays in the browser.
- `logs` accepts `from` alone, searching through now, and refuses a start older than seven days as an explicit range
  does.
- Refusals point at what clears them: `mongo` names `mongo access`, `jira update` names `jira.updateFields`, and a
  workflow hold names the action that records its evidence.

## [0.4.2] - 2026-11-06

### Changed

- Jig is published as **`@clawdbuilder/jig`**; the command is still `jig`. Install the Pi package with
  `pi install npm:@clawdbuilder/jig@<version>` and the command with `npm install -g @clawdbuilder/jig`. An existing `git:`
  install keeps working: the command recognises the old unscoped package name from git or a folder. The tarball ships the
  command, every plugin, the review page and the docs, without tests.

### Fixed

- **Nothing under a `.git` path can be written with the file tools,** at any depth. This includes a linked worktree's `.git`
  pointer file, which could otherwise send plain git to hooks the agent wrote. The sandbox locks that file for `bash` too.

- Review findings on the package and guards are fixed: nested `.git` and project paths are guarded by shape and at any
  depth, case is folded, the guard resolves the default base and remote names, blob ids are compared after a fetch, a
  remote-only merge branch is found, toolchain folders ask instead of locking, an unsafe session root is refused, and the
  doctor's absolute-program and loader-incompatible-package false failures are gone. Finding 2 is included; its blob check
  is in this release.
- A sandbox session open for more than a day no longer loses its folder to the next Pi or child agent: a folder is removed
  only when the process that owns it is gone, and a session whose folder vanished recreates it on restart. Background task
  cleanup follows the same owner rule.
- `workflow bind` with `base: "origin/develop"` no longer asks git for `origin/origin/develop`; `develop`, `origin/develop`,
  `release/1.2` and a remote whose name has a slash all resolve once.
- `jig doctor` checks a company-declared absolute program such as `process.execPath` as a path, not a PATH name, and treats
  a package only its TypeScript loader cannot read as “not checked” rather than a failure.
- **The npm packages of 0.4.0 and 0.4.1 could not run bash.** The `files` allowlist omitted
  `plugins/jig-sandbox/broker/broker.mjs`, so every sandboxed command failed with “Cannot find module … broker.mjs”; it
  also omitted the three built-in agent roles and the lens viewer. The tarball now ships all three runtime folders, a test
  derives those paths from the code, and the doctor fails when the broker or roles are missing. `npm install -g
  @clawdbuilder/jig` and `pi install npm:@clawdbuilder/jig` need 0.4.2 or later.

- `jig doctor` reads the package filter in Pi's settings, as Pi does. A filter that leaves out Jig's core or its sandbox is
  a failure naming the file to change, not an all-clear; a filter that turns off a choosable plugin is a calm skip, and a
  section that plugin left in `jig.json` is kept and comes back with it. Pi's effective entry is what is read: a project
  entry replaces the user's, and an `autoload:false` project entry adjusts it, so a repository that turns the sandbox off
  is a failure naming that repository's `.pi/settings.json`. An always-on tool that is off (git, memory, session, theme) is
  one warning with how to turn it on, and its section is kept rather than called unknown. Before this, a filter that left
  out the core still showed "0 failures" while Pi loaded Jig without its rules, approvals and protected paths.
- `jig doctor` checks the sandbox for real instead of skipping it: the programs the sandbox needs, and a real command in a
  new user namespace on Linux and WSL2, with the exact install command for the detected system. A missing program is a
  failure that says how to install it, so a setup that would refuse every bash command no longer looks finished. macOS
  says the sandbox is part of the system.
- Pi's `write` and `edit` tools can no longer change what Pi loads from a project at its next start. The settings file,
  MCP file, extensions, skills, prompts, themes, `SYSTEM.md`, `APPEND_SYSTEM.md`, the project package folders and
  `.agents` are guarded in the working folder and every folder above it below the home folder, by path and whether or not
  they exist; the message tells the agent why and to ask the person. Read still works, and normal project files are
  unaffected. `bash` locks the same list from the same table, which gains `.pi/git`, `.pi/npm`, `SYSTEM.md` and
  `APPEND_SYSTEM.md`. A person can still run `pi install -l` or edit the files themselves outside Pi; there is no new
  override, and a team repository that keeps `.pi/skills` in git is now read-only to the agent, as it already was for
  `bash`. The same now covers the home shell, session, git, agent and build start-up files, the project editor and agent
  files, `.envrc`, `~/.local/bin`, and each repository's `.git/config` and `.git/hooks`; toolchain managers ask instead.
  The bash side now reads the same table, and gains `~/.local/bin` and `.envrc`. A git operation that would change a guarded file (switch, merge, sync, rebase, cherry-pick, stash pop, restore,
  worktree add, clone) asks the person first, naming the paths and commits; a normal switch does not ask. A file-tool
  write outside the working folder, or outside a folder the person allowed with `/sandbox allow`, asks the same way;
  inside it nothing changes, and with no terminal the ask is refused.

## [0.4.0] - 2026-11-05

### Added

- `jig doctor` and `jig setup` run in a terminal, with no Pi session, model or provider login. Install the command with
  `npm install -g --allow-git=root github:ClawdBuilder/jig` (npm 12 turns git installs off by default; `#v0.4.0` pins a
  release). `jig doctor` prints the same report as `/jig doctor`, with `ok`, `warn`, `fail` and `skip` levels, and exits 0
  with no failures, 1 with one; `--json` prints the report on stdout, `--network` tests the configured hosts and the latest
  release, and `--quiet` keeps warnings and failures. `jig setup` starts with which company setup you use and where, asks
  the missing fields, asks a credential as **where** it is kept and never as a value, shows a plain summary, and writes
  once with a backup; a linked `jig.json` is followed, and an invalid one or a plugin that fails to load is a failure line,
  not a crash. Exit codes: setup 0 done, 1 failed, 130 cancelled; without a terminal it refuses in one line. `/jig setup`
  inside Pi now says to run the command; `/jig doctor` stays a shortcut through the same checks.
- A company plugin can describe its people's setup once, with `onboarding.register`: items of plain text, a pick, a
  credential's place, a login command or an explanation, in the company's order. Setup asks them with the company's
  labels and hints and the company's preferred store first; doctor turns the missing ones into "you need" lines.
  Optional: a plugin without a list falls back to its section validators.
- The command refuses to give an all-clear for a Jig Pi will not load: if Jig is not in Pi's `settings.json` packages the
  machine group fails with the install command, and setup stops before asking anything; if Pi itself is absent, the
  command stops before the doctor with "jig needs Pi installed". Two copies with different versions are a warning. Both
  commands say "Checking your setup…" before the packages load, and a records folder that does not exist yet is normal,
  not a warning.
- Project packages are not imported until Pi would trust the folder: the closest saved decision in the agent folder's
  `trust.json`, or `defaultProjectTrust: "always"` there; a malformed trust file fails closed. The doctor shows a `skip`
  line naming what was skipped, setup says the same instead of asking, and Jig listed only in an untrusted project is a
  skip, not "not installed". User-scope packages are unaffected.
- A package installed from git is found where Pi puts it: user scope under `<agent folder>/git/<host>/<path>`, project
  scope under `<cwd>/.pi/git/<host>/<path>`, with `.git` and the `@ref` stripped, and project packages read from
  `<cwd>/.pi/settings.json` too. npm packages are looked for at the folder Pi manages, with its global fallback. A package
  Pi lists but whose files are gone is a failure naming the folder, not "not installed"; the doctor's fix line is
  `pi install git:github.com/ClawdBuilder/jig`.
- Pi's four packages are optional peers now, so a global install carries no copy of Pi: it is 51 MB instead of 215 MB,
  and the command stops with "jig needs Pi installed" when Pi is absent. The repository's tests pin them as dev
  dependencies, so `npm ci` and CI still have them.
- Setup says a suggested credential in words ("Use the entry acme/sso-token"), says "Not in pass yet. Add it with:" once,
  prints "Show the exact change" as plain text, and names the company once in its confirmation.
- An audit of every tool: `plugins/jig-core/test/audit.test.ts` checks each action against its plugin's documentation and the
  effect and approval its `classify` returns, pins the classification of all of them, and reports the actions no test names.
- `/lens web`'s session view now has **where the time went**, each turn drawn as one bar split into model time, tool time
  and the time waiting for you, and **one call's text**, opened by clicking a call: its arguments and result, read from
  Pi's own session file for that session only, cut at 20,000 characters. The file holds what Jig masked before Pi wrote it,
  and the panel stays behind the page's existing secret link on `127.0.0.1`.
- `sandbox.env.remove` in `jig.json`: variable names or simple patterns (`ACME_*`, `*_SECRET`) to take out of a command's
  environment, for a credential the built-in names miss. A company's list and yours add up.
- `fetch` now asks about a remote host your own configuration does not name as a forge (`git.forges`, `git.cloneHost`,
  github.com, gitlab.com), because a fetch offers your SSH key outward. The answer is remembered for that host for the
  session; a local path or `file://` remote does not ask.

### Changed

- Action names are snake_case now, as function-calling tools and MCP write them: `run_folder`, `postman_environments`,
  `index_stats`, `create_index`, `drop_index`, `save_evidence`, `add_check`, `list_checks`, `close_check`, `submit_plan`.
  Tool names are unchanged, and so are slash commands, `jig.json` keys and the `jig` command's words. A rule, a role's
  `actions`/`ask` list or a workflow hold that still names an old, hyphenated action keeps matching through 0.4.x; `/jig`
  and `jig doctor` name each one, and 0.5.0 removes the old names. Update them when you see the notice.
- The Release workflow can be run by hand for a tag that has no GitHub release page, which publishes an older tag's notes
  without marking it the latest release.
- `config.section` hands a plugin a frozen deep copy: a plugin that tries to change another plugin's section now throws in
  its own code instead of quietly changing what `/jig` and the other plugins read.
- A review's confirmations wait in `jig-core`'s one-dialog queue like every other question. If another question is open,
  the page is told after ten seconds to answer it and approve again, instead of opening a dialog over it.
- The Mongo decision is made from the call alone: an action's effect comes from the call and its pipeline, and a call your
  settings do not allow is refused by the tool when it runs, with its own message, rather than being blocked as it is
  classified.
- Lists a company plugin gives as defaults now add up with yours where that is safe: `agents.folders` and `agents.env`,
  `workflow.disabled`, and `jira.privateNames` keep the company's entries and add yours, so a teammate cannot drop the
  company's roles, variables, disabled workflows or private names by writing a list.
- In `jig-api`, `api.reads` applies outside production only. In production a request reads only with `GET`, `HEAD` or
  `OPTIONS`, so a `POST` search listed in `reads` is a write there and the floor refuses it.
- In `jig-api`, `collections.*` is replaced whole, like `environments.*`: a teammate can point a company collection at
  their own source without the two sources being merged into an invalid entry.

### Fixed

- The doctor no longer warns "Pi — could not be read" when Pi's package is found beside the running program rather than
  the extension, and an unknown version is a skip, not a warning with a command to run. A secret store that no reference
  uses and no company prefers is not checked, so a newcomer with no `pass` store no longer sees a warning about it.
- The masking key and the preview pages are secret protected paths now: the key can confirm a masked value from a short
  list of guesses, and a preview page written when the local server could not serve it may hold unmasked text. Pi's file
  tools read neither, and the sandboxed shell cannot reach them.
- The git settings that run a program are held in one table, shared by the check before git runs and the sandbox's check
  after a command. It gains the keys one copy had missed, and a repository whose local configuration sets an alias
  starting with `!` is now refused by both.
- A drive prefix such as `C:/repos/x` is treated as a path only on Windows; elsewhere git reads it as an SSH address, so
  it is refused or asks instead of passing as local.
- The environment a command starts with removes credentials by their value as well as their name: an address with a
  password in it goes whatever the variable is called, and `_PWD`, `_DSN`, `_WEBHOOK` and `_PAT` names are covered.
  `env.keep` still wins.
- `jig-review` opens the page correctly when `$BROWSER` holds arguments (`firefox --new-window`), using the same parser as
  Jig's preview pages.
- A tool declaration whose `approval` is not a kind Jig knows, or whose `action` is not a string, blocks the call as an
  invalid declaration instead of quietly using a different approval screen.

## [0.3.0] - 2026-11-04

### Added

- Contributing and security pages, code owners, and issue and pull request templates: the rules a person follows, beside the
  [AGENTS.md](AGENTS.md) guide the coding agents read.
- `docs/releases.md`, `scripts/release.mjs` and a Release workflow: a release is one command and one tag, and the GitHub
  release's notes are that version's changelog section.

- Herdr Review tab: a `Diff | File | Patch` switch in the diff header; `File` and `Patch` show the file's text or the diff's text in a read-only editor where the mouse drags a selection and `Ctrl+C` copies it (the view is remembered), and shift-click in `Diff` now takes focus first so the range extends.
- Herdr Review tab: the file list is resizable (drag the divider; the width is remembered), and code can be copied. Click a diff line (shift-click to extend, `Escape` to clear) and press `Ctrl+C` or `Copy N lines` to copy it without markers or line numbers; `Copy file` and `Copy path` are in the diff header.
- Company profiles. `profiles` and `profile` in `jig.json` choose which company plugin applies to the work at hand, by working folder or git remote; `/profile` shows the choice and why, and `/profile <name>` sets it for the session. A company plugin registers with `profiles.register`, and only the active company's environments, rules, section defaults, secret settings, status and skills apply. With no `profiles` section and one company plugin, it is active as before. See `plugins/jig-core/docs/profiles.md`.
- Skill overlays. A company plugin ships `overlays/<skill>.md`; jig-core merges it into the generic skill (a `## <Company> rules` section) under the state folder and points the skill list at the merged file, so the model reads one skill instead of a generic one and a company one. `examples/jig-acme` moves `acme-jira` to an overlay.
- Herdr Changes panel: a checkout with commits its base branch lacks shows a chip such as `3 commits vs develop`, and a click opens the Review tab in branch mode: the file list and diff of the whole branch against `git merge-base` (committed and uncommitted work, read-only), with a switch to the working changes. The base is the closest of origin/develop, origin's HEAD branch, origin/main, origin/master and the local develop, main, master; a checkout on one of them has none. A clean checkout with commits ahead moves out of `Clean`.
- Herdr History panel: when the commit filter matches nothing, repositories and worktrees whose folder name or branch matches the text are offered under `Look in another repo`.
- `deploy` with a pin (a version line in a control repository): the catalog's `pin` method and a read-only `pinned` entry for production; `deploy status` says what is pinned, for whom, who changed it last and the open pin pull requests; `deploy plan` shows the line a run would change; and a `ci trigger` preview says what the environment is pinned to. Reads only; `deploy run` for a pin comes later.
- `/lens web`: a page of charts and tables over `jig-lens`'s index, served by Pi on `127.0.0.1` behind a secret link,
  read-only, with nothing to install: cost per day, sessions and tickets, every turn and call of a session with child
  agents nested, tools with p50 and p95 and loops of repeated failures, and your waiting time. It stops when Pi exits, and
  `/lens status` reports it. It is now the recommended viewer; Grafana and Datasette are optional extras.
- `tools.deferred` in `jig.json` names Jig tools to register `deferred`: their descriptions stay out of the context until Pi's
  `tool_search` finds them, and `jig-core` activates `tool_search` when a Jig tool is deferred. Plugins register their tools
  through the kit's `registerJigTool`.
- A workflow stage can name tools (`"tools": ["deploy"]`): `jig-workflow` activates them while the work is in the stage, and
  takes out on leaving only the ones it added, never one you switched on yourself.
- `approvals.openInBrowser` in `jig.json`: `"always"` opens a review screen's preview in the browser as soon as the screen appears (once per question); the default `"on-key"` keeps the `o` key.
- `workflow test` picks the JDK a Gradle build needs from its files (the wrapper's Gradle version, the build's Java level, and each installed JDK's `release` file), so no repository needs its own `JAVA_HOME`; a configured one still wins, and the result says which JDK ran and why.
- `ci` with Concourse: a job's builds, one build and its log, trigger and watch. The token comes from a credential you configure
  (such as `cmd:` reading what `fly login` saved); Jig never signs in. A paused pipeline or a job closed to manual starts is
  refused before anyone is asked.
- `jig-core` requests can stop at a marker in the reply, for a stream that never closes on its own.
- A Context panel in the Herdr app files: what fills the session's context (messages, tools, system prompt, skills, context
  files, the compaction buffer, free space), a switch for each tool and skill of that session, and Reload. `jig-session`
  writes the figures into its status file and takes the switches from a request file; `/session-reload` reloads when idle.
- A service's environment can name its own CI job (`environments.<name>.job`), and `ci` takes an `environment`: "build orders-api for staging" runs that environment's job. A write in a test environment asks; one in production is refused before asking.
- `ticket` tool (`jig-memory`): `save-evidence` keeps output the user pasted in the ticket's evidence, masked; `add-check`,
  `list-checks` and `close-check` keep open checks in `checks.json`, shown with every prompt until closed.
- When a ticket becomes active or is restored, files in its folder that are empty and changed in the last 7 days are named to the
  agent and to you, as a sign of a write cut short by a crash.
- `api postman-environments`: the names and ids of the Postman environments a cloud collection's key can see, never their values.

### Changed

- The install section says how to pin a release (`@v0.3.0`) as well as how to follow `main`, and [Releases](docs/releases.md)
  says what a version number means.

- The Herdr Work panel's Outputs list shows only files outside git repositories (ticket notes, plans, reports); a line under it counts the files changed in repositories and opens the Changes section. `jig-session` adds `repo` to each output (the working tree's root, or null) and caps the two kinds separately.

- After a push, the result says how the agent will hear when CI finishes (a running `ci` watch, or the call that starts one), and the model is told that a promise to report on CI needs a watch.
- A command that fails because the sandbox makes no Unix socket (a JVM attaching to itself, Docker, a socket tool) says so in one line, and how to run it outside with the user's approval.
- The `## Now` reminder stops only when `## Now` itself changes, not at any edit of `notes.md`, and the notes message and the
  reminder say today's local date.

### Fixed

- The Herdr Work panel's Outputs no longer empty after Pi restarts or a session resumes: `jig-session` rebuilds them from the session's `edit` and `write` calls and lists the active ticket's notes, plans and evidence files (not `ticket.json`, `workflow.json` or `history/`).

- The `o` key on the review screen opens the preview over `http://localhost` from a small server on this machine, not as a file, so it opens in a Windows browser under WSL; it says which address it opened, and why when it could not (the launcher failed, or the server could not start; off WSL a file is then used, and under WSL, or with a Windows program as the opener, none is, because Windows warns about a network file).
- Files Jig writes for itself (its state, ticket notes and evidence, the Postman copy, themes, passkeys, the sandbox's lists) are
  synced to disk before they take their name, so a killed machine no longer leaves one empty. `kit/files.ts` holds the helper.
- The local packages Pi loads from its settings (and the extension files it loaded) are guarded: the sandboxed `bash` cannot change code that runs unsandboxed at the next start, and Pi's file tools refuse to write it.

## [0.2.0] - 2026-11-02

### Added

- `startChecks` in `jig.json`: hosts to reach when a session starts, such as one behind a VPN. One notice for each that does not
  answer; nothing is retried or started.
- `secrets.pass.unlockAtStart`: the password store is unlocked when a session starts, by its own passphrase prompt, so a task is
  not interrupted later.
- `secrets.pass.storeDir` and `gnupgHome`: where `pass` looks, bound in `jig.json` whatever starts Pi.
- `bin/pi`, an optional launcher: Pi inside tmux outside herdr, and reattach to a Pi still running in this folder.
- `jira search` with `commented: { by, from, to }`: the issues someone commented on in a period, exactly.
- `/lens compare`, roles for child agents, and guards that keep the repository's checks honest.

### Changed

- Tested with Pi 1.5.0. Tool parameters that are one of some strings are built by `jig-core`'s `stringEnum`, which reads the
  same on every Pi.
- Pi's extension list names each plugin (`jig-core`), not `jig-core/src`.
- The review offered after a run shows what the agent did, not what a merge, pull or rebase brought in.
- An approval screen tells the terminal that Pi waits for permission, so a terminal app that lists agents shows it as waiting.

### Fixed

- A password store or key ring moved by `PASSWORD_STORE_DIR`, `GNUPGHOME` or another credential variable is hidden from `bash`
  and Pi's file tools, as the usual folders are.

## [0.1.0] - 2026-10-31

- The first set of plugins: `jig-core`, `jig-sandbox`, `jig-memory`, `jig-workflow`, `jig-agents`, `jig-git`, `jig-lens`,
  `jig-jira`, `jig-logs`, `jig-api`, `jig-ops`, `jig-review`, `jig-mongo` and `jig-theme`.
