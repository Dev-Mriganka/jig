# Options

The Pi store's subagent packages compared against Jig's criteria, what each one does to
Jig's rules, what the earlier harness's pane-based copy taught, and
[how Claude Code, Codex and `pi-subagents` specialise a subagent](#specialisation-compared-2026-11-01).
Back to the [jig-agents overview](../README.md).

Checked on 2026-10-31 against Pi 1.4.0. Nothing was installed or run. Statements come
from each package's README and from reading the code that launches a child, answers its
dialogs and enforces limits. Download counts are for one week (23 to 29 October), from npm.

## How it was checked

- **Found:** npm searches for `keywords:pi-package` with `subagent`, `agents`, `delegate`,
  `team`, `orchestrat` and `parallel`. Each search returns a limited list, so this is a
  sample of the store, not a count of it. It gave about 250 names.
- **Sorted:** 146 of them looked like subagent tools by name, and their weekly downloads
  were read. The top 20 or so were read by README.
- **Read in code:** `pi-subagents`, HazAT's `pi-interactive-subagents` (from its
  repository, since it is not on npm), `@tintinweb/pi-subagents`, `@gotgenes/pi-subagents`
  with `@gotgenes/pi-permission-system`, `@deathbeam/pi-delegate`,
  `@ferris1225/pi-subagents` and `pi-landstrip`. For five more only the launch arguments
  were read.
- **Pi itself:** the CLI, SDK, extension and RPC documents, and the RPC source.

## The criteria

In order, from the brief for this plugin:
1. every child's tool calls go through `jig-core` and its `bash` through `jig-sandbox`,
   and "ask" in a child with no screen becomes "deny" or goes to the parent's screen,
   never auto-allowed;
2. limits on turns, time and cost;
3. the parent gets the result back without polling;
4. each role's model comes from configuration, which a company plugin sets, not from agent files;
5. maintained, with a licence that is MIT or Apache-2.0;
6. small.

## The field

| Package | A week | How a child runs | Size | Licence | Last release |
|---|---|---|---|---|---|
| `pi-subagents` | 326,000 | In the parent; background in a detached runner | 10.7 MB, 778 files | MIT | 2026-10-29 |
| `@tintinweb/pi-subagents` | 13,300 | In the parent's process | 2.6 MB, 193 files | MIT | 2026-10-30 |
| `@gotgenes/pi-subagents` | 4,900 | In the parent's process | 1.3 MB, 117 files | MIT | 2026-10-28 |
| `@henryqw/pi-subagent` | 3,500 | Separate Pi, in Herdr panes | 1.7 MB, 6 sibling packages | MIT | 2026-10-30 |
| `pi-landstrip` | 2,800 | Separate Pi, in its own OS sandbox | 347 KB | Apache-2.0 | 2026-10-31 |
| `@deathbeam/pi-delegate` | 2,500 | Separate Pi, RPC mode | 112 KB, about 2,300 lines | MIT | 2026-10-29 |
| `@ferris1225/pi-subagents` | 2,400 | Separate Pi, RPC mode | 537 KB | MIT | 2026-10-30 |
| HazAT `pi-interactive-subagents` | not on npm | Separate Pi, in tmux, cmux, zellij or WezTerm | 630 KB, 5,000 lines | MIT | 2026-05-13 |

Age and pace matter for a plugin that tracks Pi: `pi-subagents` has 156 releases since
January, `@gotgenes/pi-subagents` 209 since May, `@ferris1225/pi-subagents` 121 since
August and `@deathbeam/pi-delegate` 39 since September. HazAT's package has 726 stars,
22 open issues and pull requests, and no release for five months.

## Against the criteria

| Package | 1: rules reach the child | 1: a child's question | 2: limits | 4: models |
|---|---|---|---|---|
| `pi-subagents` | Not in foreground children; yes in background | Denied (no screen) | Run time; spawn counts | In Pi settings |
| `@tintinweb/pi-subagents` | Yes by default; an agent file can turn it off | Denied (no screen) | Turns | Agent files |
| `@gotgenes/pi-subagents` | Yes by default | Forwarded, only by its own permission package | Turns | Agent files |
| `@henryqw/pi-subagent` | No: `--no-extensions` | Not applicable | Not read | Configured roles |
| `pi-landstrip` | Its own sandbox and gate replace Jig's | Forwarded by its own gate | Worker count | Its config file |
| `@deathbeam/pi-delegate` | Yes | Cancelled, so denied | None | Tiers in settings |
| `@ferris1225/pi-subagents` | Yes | Cancelled, so denied | Idle time only | Yes, 4 fixed roles |
| HazAT | Yes | Asked in the child's pane | None | Agent files |
| **`jig-agents` (as built)** | **Always, checked at start** | **Forwarded to your screen, else denied** | **Turns, minutes, cost** | **Configuration only** |

Criterion 3 is met by all of them: each sends a follow-up message when a child ends.
Criteria 5 and 6 are in the next table.

## Against criteria 5 and 6

| Package | Maintained and licensed | Small |
|---|---|---|
| `pi-subagents` | Yes, MIT | No: 10.7 MB, five dependencies, 80 parameters on one tool |
| `@tintinweb/pi-subagents` | Yes, MIT; 113 open issues | No: workflows, scheduling, mentions |
| `@gotgenes/pi-subagents` | Yes, MIT | Medium: 1.3 MB |
| `@deathbeam/pi-delegate` | Young, 0.0.x, MIT | Yes |
| `@ferris1225/pi-subagents` | Young, MIT | Medium |
| HazAT | Stale since May | Medium |

## What each one does

**`pi-subagents`** (nicobailon). By far the most used.
- Foreground children are SDK sessions inside the parent process and **load no ambient
  extensions**, so neither `jig-core` nor `jig-sandbox` reaches them. Background children
  run in a detached runner process and do load them.
- A host can force plugins into every child with `registerRequiredChildExtensions`.
  That would fix the first point for this package alone.
- Children have no screen in either place, so an "ask" is denied. Its own opt-in
  permission rules ask a *model* to approve or deny, a second approval system.
- Limits: a run deadline (30 minutes by default), per-tool timeouts and spawn counts.
  A cost cap stops only later launches. No turn limit.
- Models can be set in Pi settings (`agentOverrides`), so criterion 4 is met.
- It needs Pi 1.2 or later, and 5 dependencies.

**HazAT's `pi-interactive-subagents`.** The package the earlier harness adapted.
- A child is a full `pi` started in a multiplexer pane with one extra extension, so it
  loads everything. The command is typed into the pane's shell.
- A child's question appears in its own pane, where it waits until you go there. There
  are no limits. Models are set in agent files.
- It also starts Claude Code children. Its peers are the old `@mariozechner/*` scope at
  Pi 0.65; Pi 1.4 still aliases that scope. Not run.

**`@tintinweb/pi-subagents`** and its forks, `@cad0p/pi-subagents-tintinweb` (5,300 a
week) and a private `opensec-pi-subagents`, whose licence is Apache-2.0 in one place and
"proprietary" in another.
- SDK sessions in the parent's process. All discovered extensions load by default, with
  no screen, so an "ask" is denied.
- Agent files are read from the project's `.pi/agents`, which the model can write, and
  can say `extensions: false` or `isolated: true`. That turns Jig off in a child.
- `max_turns` steers the child once and aborts it after a grace period. No time or cost limit.

**`@gotgenes/pi-subagents`.** A hard fork of the one above, with a typed API.
- In-process. Its configuration page says that a plugin loaded once per child can
  exhaust the heap with four children at a time.
- Its sibling `@gotgenes/pi-permission-system` forwards a child's "ask" to the parent's
  screen, through files in Pi's session folder. That works only with that package, which
  `jig-core` replaces ([Reuse](../../../docs/reuse.md#tool-manager)).
- `max_turns` is a hard ceiling, with wrap-up warnings. No time or cost limit. Models are
  in agent files, though `locked` stops a caller changing them.

**`@deathbeam/pi-delegate`.** The closest to what is wanted.
- A child is `pi --mode rpc` with no extension flags, so it loads everything. Its
  dialogs are cancelled in `child.ts`, which `jig-core` reads as a decline. A result
  arrives as a steering message.
- Model tiers (`cheap`, `balanced`, `strong`) are set in `settings.json`, which is the
  right shape. It also merges the project's `.pi/settings.json`, and agent folders from
  it, which the model can write.
- No limits. No way to forward a question, because the cancel is inside its launch code.

**`@ferris1225/pi-subagents`.** Also RPC, written for Pi 1.4.
- Dialogs are cancelled with a stderr note ("approval was not granted"). Roles' models
  are in `~/.pi/agent/pi-subagents.json`. Only `scout`, `artisan`, `sentinel` and
  `skeptic` exist: "custom roles are not supported". An idle timeout, but no turn or cost cap.

**`@henryqw/pi-subagent`.** Needs Herdr, and starts every child with `--no-extensions
--no-skills`, adding only the extensions a role lists. Jig's plugins are absent unless
every role names them.

**`pi-landstrip`.** A sandbox, a permission layer and subagents as one stack. It forwards
a worker's dialog to the parent, and runs workers inside its own OS sandbox. It replaces
`bash` and brings its own approvals, so it would sit beside `jig-sandbox` and `jig-core`,
not under them.

## Also looked at

| Package | A week | Why not |
|---|---|---|
| `pi-cohort` | 2,300 | `--no-extensions` when an agent lists extensions; print mode |
| `pi-better-subagents` | 1,300 | `--no-extensions` in nine places; its own sandbox |
| `@heyhuynhgiabuu/pi-task` | 830 | tmux or Herdr; "fast" children run `--no-extensions`; 11 MB |
| `@chankov/agent-fleet` | 3,200 | 142 MB: it ships every old version of itself |
| `@agimon-ai/po-team` | 7,900 | BUSL-1.1, not MIT or Apache-2.0 |
| `pi-background-tasks` | 7,000 | ISC; background shell tasks, with agents as a side feature |
| `@maplezzk/pi-interactive-subagents` | 130 | A fork of HazAT's |
| `@nicknisi/pi-subagents`, `@d3ara1n/pi-subagent`, `@fitchmultz/pi-subagents` | 130 to 1,400 | Hermetic in-process sessions, or RPC; not read further |
| `pi-durable-subagents`, `pi-neo-subagents` | 2,000 each | Not read beyond the README; the second calls itself experimental |

## Three ways to go

**Adopt one as it is.** The nearest are `@deathbeam/pi-delegate` and `pi-subagents`. The
first has no limits and cannot forward a question. The second does not govern foreground
children, has no turn limit and its cost cap stops no running child. Neither meets
criterion 2, and the others fail criterion 1 or 2 as well.

**Adopt one with a thin plugin around it.** Three things cannot be added from outside:
- **A child's dialogs.** They are answered inside the package's launch code
  (`runChild`, `cli-run.ts`), where a wrapper cannot reach.
- **Limits that stop a running child.** They need the child's event stream, which the
  package owns.
- **The list of extensions.** In some it is set by an agent file or a call. Only
  `pi-subagents` has a hook that forces plugins in, and it leaves the other two, and its size.

**Build our own.** Small, because Pi supplies the hard parts: RPC mode with dialogs
forwarded, `get_session_stats`, `abort`, `steer`, and a shutdown when input ends.
`jig-core` supplies the watch engine that returns a result. Pi's `RpcClient` delivers
dialog requests to listeners but has no public way to answer one, so the plugin keeps
its own client (`src/rpc.ts`, about 250 lines with its comments). **This is the choice** ([Decisions](../../../docs/decisions.md#2026-10-31-jig-agents-is-built-by-us-on-pis-rpc-mode)).

Nothing is copied from these packages. What is borrowed is an idea each:
- from the earlier harness: agent files only from places the model cannot write, models
  checked against `enabledModels`, a working folder inside the parent's, and an
  environment list;
- from `@deathbeam/pi-delegate`: a separate Pi in RPC mode with its model set in settings;
- from `@gotgenes/pi-subagents`: forwarding a child's question to the parent's screen;
- from `pi-subagents`: forcing the plugins into a child, here as a check at start.

## What the earlier harness taught

| Lesson | In `jig-agents` |
|---|---|
| Children left behind: `/new`, `/resume` and `/fork` kept them running for a result no one gets | A child ends with its parent session, for any reason |
| A prompt that says "about 25 calls" is a request, not a limit | The parent enforces turns, minutes and cost |
| Limits checked at a turn end let a ten-minute tool call overrun | A timer checks minutes |
| The agent delegated only when asked to | The tool names one rule; `jig-workflow` can name `reviewer` |
| A pane could not be trusted after a reload or on another tmux server | There are no panes and no adoption: `message` resumes from the session |
| Stalls needed a one-minute watch | The parent sees every event; a stall is time since the last one |
| Keystrokes typed into a pane's shell were fragile | The command is built and spawned directly |
| A model could choose its own model and folder | Neither is a parameter of `start` |
| Project agent files are model-written | Never read |

## What dropping panes costs

- **A live view of a child,** and typing into it. `/agents show` prints the transcript;
  `/agents say` steers. An opt-in terminal view is under *Later*.
- **Children that outlive a `/reload`.** They end, and resume from their sessions.
- **Interactive roles,** such as the planner that asked you questions in its pane.
- **What it buys:** no tmux needed, so it works in any terminal and on macOS; no orphans;
  and a screen that only the parent owns, which makes forwarding questions possible.

## Specialisation compared (2026-11-01)

What an agent file can set, in the tools people use most and in Jig, and what Jig took. This is from their public
documentation and, for Codex, its source at version 0.166.0; nothing was installed or run. A dash means no such field was found.

| An agent file can set | Claude Code | Codex | `pi-subagents` | `jig-agents` |
|---|---|---|---|---|
| The prompt | the body | `developer_instructions` | the body | the body |
| Which tools | `tools`, `disallowedTools` | switch features off | `tools`, `excludeTools` | `tools` |
| One action of a tool | no: shared permission rules | no: shared command rules | per tool only (`permission`) | `actions` and `ask`, enforced in the child |
| Read-only | `permissionMode` | cannot change the parent's sandbox | `permission` | `writes: false`, a gate and the sandbox |
| Model and effort | `model`, `effort` | model, reasoning effort | settings `agentOverrides` | model in configuration; `thinking` |
| Skills | `skills`, whole text preloaded | switch skills off | `skills`, `inheritSkills` | `skills`, `preload`; by default they follow the tools |
| Project instructions | `omitClaudeMd` | — | `inheritProjectContext` | `context` |
| Memory | `memory` (a folder) | a feature switch | a `memory` scope | later |
| Hooks and MCP servers | `hooks`, `mcpServers` | cannot override the parent | `extensions` | no: the parent's plugins, always |
| Where a file may come from | managed settings, project, user, plugin | user, project | — | plugin, configured, user; never the project |

- **Claude Code** reads agent files from [managed settings, the project, the user and plugins](https://code.claude.com/docs/en/sub-agents).
  Its tool control in the file is whole tools; patterns such as `Bash(git status:*)` live in the general permission rules, which every
  subagent inherits. A parent in a bypass mode wins over the file's `permissionMode`.
- **Codex** reads [TOML files](https://learn.chatgpt.com/docs/agent-configuration/subagents) and applies only a whitelist: model, reasoning
  effort, verbosity, personality, service tier, and switching features and skills off. `sandbox_mode`, `approval_policy` and
  `mcp_servers` in a file do not override the parent. A comment in its source (`codex-rs/core/src/agent/role.rs`, in
  [openai/codex](https://github.com/openai/codex)) says roles "may customize the child or reduce its capabilities, but never replace
  the parent session's authority".
- **[`pi-subagents`](https://www.npmjs.com/package/pi-subagents)** has the widest set of fields, and settings (`agentOverrides.<name>`)
  that override the files.

**The common ground.**
- **Nobody controls one action of a tool in the agent file.** All of them rely on a separate permission layer that the child inherits.
- **Specialising is** a prompt, a model and effort, tools, skills, project instructions on or off, and memory.
- **Depth is kept low** (one to three levels). Readers run in parallel, writers are isolated, and the final report is the result.
- **Teams are experimental everywhere,** and costly: Claude Code's costs page says about seven times the tokens of one session.

**What Jig takes.**
1. **A role can only narrow, and the child enforces it,** from Codex. Jig goes a step further than the others: `actions` and `ask` are
   per action, and a gate in the child enforces them, because Jig has a permission layer that every child already runs.
2. **More fields,** from Claude Code and `pi-subagents`: `skills` and `preload`, `context`, `thinking`. Configuration can replace them,
   as `pi-subagents`' `agentOverrides` can, because they give a child less to read and are not authority.
3. **Later:** structured verdicts for `jig-workflow`, `ask_parent` (which `@gotgenes/pi-subagents` has), a live view of a child (HazAT's
   package has panes), a `memory` field and a way to measure delegation. A company's roles already come through `agents.folders`.

**What Jig does not take:** teams, chain languages, scheduled agents, a model that chooses a child's model, hooks or MCP servers per
role (a child has its parent's plugins), and a `permissionMode` (Jig's modes are the rules and the floor, which a role cannot change).

## Not verified

- **Nothing was installed or run.** Every row above is from a README or from code, and a
  package may behave differently from its source.
- **Pi's RPC mode with `jig-core`.** This was true when the comparison was made. The plugin
  has since run a real Pi child with `jig-core` loaded, and forwarded its questions (see
  [Design](design.md#tests)); the comparison itself is unchanged.
- **HazAT's package on Pi 1.4.** Its dependencies are the old scope; the alias is in
  Pi's source, and the package was not loaded.
- **Packages read only by README or launch arguments** may differ in the points the
  tables leave blank, such as limits, marked "not read".
- **Downloads** are one week and include installs by bots and mirrors.

Back to the [jig-agents overview](../README.md).
