# jig-agents: child agents that Jig's rules still govern

**Status: built.** Tested with a fake child that speaks Pi's RPC protocol, and with the stock Pi 1.4 as a real child
(this repository's `jig-core` and `jig-agents`, on Pi's own scripted model). No model is called; what only
a real one can show is in [Not verified](docs/not-verified.md).

`jig-agents` lets the agent hand work to **child agents**. A child is a separate Pi process that loads the
same plugins as its parent, so `jig-core` governs its tool calls and `jig-sandbox` its `bash`.

A child is started from a **role**, and a role can only make a child *less* than its parent: fewer tools, fewer
actions of a tool, no writing, fewer skills to read. The child enforces that itself, so neither the parent nor
a prompt has to be trusted.

When a child's rules say "ask", the question comes to your screen, labelled with the child's name, and your
answer goes back. Each child has limits on turns, minutes and cost, and its report reaches the parent
without polling.

For example, the agent starts a `scout` with the task "find where `orders-api` rounds order totals" and carries
on. The scout can read the code and run `rg`, `git log` and `git blame`; it cannot edit a file or push. When it
finishes, its report arrives as a message.

![The agent starts a child through jig-agents, which runs a separate Pi in RPC mode with the same plugins, sends it the task, counts its limits, brings its questions to your screen and your answers back, and delivers its report as a message](../../docs/img/agents-rpc.svg)

*How a child runs. The child is a full Pi with the same plugins, so Jig's rules govern it; its questions come to you through the parent, and its report comes back without polling.*

## The decision

Jig builds this plugin itself, on Pi's own RPC mode, and adopts no package: none of the Pi store's subagent
packages keeps every child under `jig-core` and `jig-sandbox`, brings its questions to your screen, and limits
turns, time and cost. See [Options](docs/options.md) and
[the decision](../../docs/decisions.md#2026-10-31-jig-agents-is-built-by-us-on-pis-rpc-mode).

## Tool: `subagent`

| Action | Kind | What it does |
|---|---|---|
| `start` | local write | Starts a child from a role and a task, and returns at once |
| `status` | read | This session's children: state, turn, minutes, cost, questions waiting |
| `message` | local write | Steers a running child, or resumes a finished one in a new process |
| `stop` | local write | Stops a child and returns its partial report |

`start` takes a `role`, a `task`, and optionally a `name` and a `cwd` inside the parent's folder. It takes no
model and no tool list: those come from the role and configuration.

| Command | What it does |
|---|---|
| `/agents` | The children of this session and any problem; `/agents roles` lists the roles |
| `/agents show <id>` | The last lines of a child's transcript |
| `/agents say <id> <text>`, `/agents stop <id>` | `message` and `stop`, typed by you |

## Roles and agent files

A **role** is an agent file: Markdown with a few lines of front matter and a prompt. The one rule behind every
field is Codex's ([how the others do it](docs/options.md#specialisation-compared-2026-11-01)):
**a role can only narrow what its child may do, never widen it, and the child enforces it.**

The parent hands the child its role's limits in one environment variable, and a gate in the child's own `jig-core`
refuses what the role does not allow. A gate can only make a decision stricter, so the child's usual rules and the
[floor](../../docs/permissions.md) still apply on top. [Design](docs/design.md#a-role-only-narrows-and-the-child-enforces-it)
says why this holds.

### An agent file

This file uses every field. Lines that start with `#` are comments.

```markdown
---
# The name defaults to the file name.
name: orders-fixer
# One line, which the parent agent reads when it chooses a role.
description: Fixes one bug in orders-api in a worktree of its own, tests it and reports
# The only tools the child has. A role that does not write must list them.
tools: read, write, edit, bash, git, grep, find, ls
# For a tool named here, only these actions run. A tool not named keeps all of its actions.
actions: git status|diff|log|show|commit|push
# These actions ask you even if the rules would allow them. They must be among the actions above.
ask: git push
# Whether the role may write. Default false; a role that writes works in a worktree of its own.
writes: true
# The skills the child sees: none, or exactly these. Left out, they follow the tools.
skills: git, orders-testing
# Skills whose whole text is in the child's instructions from the start. Each must also be in skills.
preload: orders-testing
# project (the default) or none: whether the child reads the project's AGENTS.md and CLAUDE.md.
context: project
# Pi's thinking level, if you want one. Configuration can replace it.
thinking: medium
---

You fix the one bug in the task, in this folder, and report. Change only what the fix needs.
```

The body is the role's prompt. There is no model and there are no limits in the file, so a public agent file never
names a company's model: they come from [configuration](#configure).

### Every field

| Field | Meaning | Default | Who may change it |
|---|---|---|---|
| `name` | Letters, digits, `-` and `_` | the file name | the file |
| `description` | One line for the parent agent | none, required | the file |
| `tools` | The tools the child has | the usual tools (a writer only) | the file |
| `actions` | For a tool named, the only actions that run | every action | the file; configuration narrows |
| `ask` | Tool actions that ask even if the rules allow | none | the file; configuration adds |
| `writes` | Whether the role may write | `false` | the file only |
| `skills` | `none`, or the skills the child sees | those that follow the tools | the file; configuration replaces |
| `preload` | Skills whose whole text starts in the instructions | none | the file; configuration replaces |
| `context` | `project` or `none` | `project` | the file; configuration replaces |
| `thinking` | Pi's thinking level | the model's own, else the parent's | the file; configuration replaces |
| `model`, limits, `approvals` | Not file fields: a file that names one is an error | the parent's, [limits](#limits) | configuration only |
| `extensions` | Not a field: a child always loads its parent's plugins | all of them | neither |

- **`actions` and `ask` are one line:** `actions: git status|log|diff, jira get|search`. A tool and an action are
  names, a tool must also be in `tools`, and a tool is named once.
- **Configuration can never widen.** `writes` is not a setting. A tool in both the file's `actions` and
  configuration's keeps the actions both list, so configuration cannot add `push`. Its `ask` adds to the file's.
- **A file of your own replaces a shipped role of the same name.** That is your file, in a place the model cannot
  write; it is not configuration, and it is what you use to change `writes` or `tools`.

### The roles that ship

| Role | May write | Tools | Git actions | For |
|---|---|---|---|---|
| `scout` | no | read, grep, find, ls, git, logs, bash | the reads: status, diff, log, show, blame, branches | Exploring code, logs and tickets, with evidence |
| `reviewer` | no | read, grep, find, ls, git, bash | the same reads: status, diff, log, show, blame, branches | Reviewing a diff or branch with fresh eyes |
| `worker` | yes | read, write, edit, bash, git, grep, find, ls | all; a push asks | One scoped change, in a worktree, tested |

- **A worker gets a worktree:** a new folder beside the repository, on a new branch, made through `jig-core`'s
  git. The report names the branch. `git push` asks by default, so the worker needs no `ask` line.
- **Read from three places:** the plugin's `agents/`, `agents.folders`, and `~/.pi/agent/agents/`. Never from the
  project, because the model can write there. A bad file is skipped, and `/agents roles` names it and the field.
- **`/agents roles` shows the result:** per role, its tools, actions, ask, writes, skills (the list as it will be),
  preload, context, thinking, model and limits, and for each whether it came from the file or from configuration.

### Which skills a child sees

Pi lists every skill it knows to the model, so a child for a narrow job would carry the skills of tools it
cannot call. `skills:` is the choice, and when it is left out the skills **follow the tools**:

- **A skill that belongs to a plugin** is seen only when the role has a tool that plugin registers. Jig's own
  skills sit in `plugins/<plugin>/skills/`. A scout with `git` and `logs` sees the git and logs skills, and not the Jira or deploy ones.
- **A company skill says which tool it extends,** with the `metadata` field the Agent Skills format keeps for this, and
  Pi accepts:

  ```markdown
  ---
  name: acme-jira
  description: Acme's Jira rules on top of the jira skill. Use whenever the user names an ACME-123 key.
  metadata:
    jig-tool: jira
  ---
  ```

- **A skill with no known owner is always seen,** and so is every skill for a role with no `tools` list.
- **`preload`** puts a skill's whole text in the child's instructions at start, because a model may fail to load a
  skill it needs. The skill is also listed, as every preloaded skill must be.

The parent starts the child with `--no-skills` and one `--skill` for each skill it keeps, and with `--no-context-files`
for `context: none`.

### Read-only bash

A shell command can write, so `jig-core` calls every `bash` a write, and a role with `writes: false` could not have it.
A read-only role may list `bash` **when the child has `jig-sandbox`**.

In such a child the sandbox locks the working folder and the home folder, so a command reads them and writes neither;
`/tmp` stays writable for scratch files. The build caches in the home folder are locked too, so a read-only agent
cannot poison one.

- **Where there is no sandbox, the role is refused** at `start` and in `/agents roles`, with the way out.
- **`bash` with `outside: true`**, which runs outside the sandbox, is a different action and is refused.
- **`write` and `edit` stay forbidden** in a read-only role, and so do `powershell` and `notebook_edit`.

## Approvals in a child

A child asks through `jig-core` as its parent would. Pi's RPC mode turns the child's dialog into a request on
its output. The parent shows it on your screen, one at a time and behind `jig-core`'s own questions, under a
line the plugin writes (`Subagent "scout-2" (scout) asks.`), and sends your answer back by the request's random
id on a pipe only the parent holds. The agent cannot answer for itself: the pipe is not a file or a web endpoint.

- **Every failure is a no.** No screen, no answer within `approvalWaitMinutes`, more than `maxAsks` questions,
  or a request the plugin cannot read: the question is cancelled, and the child's `jig-core` counts that as a
  decline.
- **The floor is decided in the child.** A yes only settles what the child's own rules left as "ask".
  "Allow for this session" is shown as "Allow for this subagent" and ends with that child. A role set to
  `approvals: "deny"` never forwards.

[Design](docs/design.md#approvals-in-a-child) has the path, the checks and the attacks considered.

## Limits

| Limit | Default | How it is counted |
|---|---|---|
| `maxTurns` | 40 | The parent counts the child's finished turns |
| `maxMinutes` | 30 | Wall clock, not counting time spent waiting for you |
| `maxCost` | 2 | US dollars Pi reports for the child, checked after each turn |

At a limit the child is told to write its report from what it has, gets two more turns or minutes, and is
then aborted. The report says which limit stopped it. Cost is bounded only for a model that Pi prices, and
there is no "no limit" setting.

## Rules

- **A role only narrows, and the child enforces it.** The parent passes the policy in the child's environment; the
  child reads it at start. A policy it cannot read makes the child refuse to work, and the start fail.
- **Never fewer extensions.** The plugin never passes `--no-extensions` or `-e`, and stops a child that does
  not list the commands of `jig-core` and `jig-agents` (and of `jig-sandbox`, when the parent has it) before it
  gets its task. `jig-core` is what governs the child, and `jig-agents` is what enforces its role there: a child
  without it would run unnarrowed.
- **One writer per folder,** in a worktree other than the parent's.
- **No orphans.** A child ends with its parent session, for any reason; one left by a parent that died is
  stopped at the next session start.
- **Few children.** `maxRunning` (4) at once, `maxStarted` (30) per session, none started by a child.

## Configure

In `~/.pi/agent/jig.json`, under `agents`. Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `roles.<role>.model` | the parent's | `provider/id`, with `:thinking` if wanted; checked against `enabledModels` |
| `roles.<role>.maxTurns`, `.maxMinutes`, `.maxCost` | `limits` | Limits for one role |
| `roles.<role>.actions`, `.ask` | the file's | `{ "git": ["status", "log"] }`: narrows the file's actions, adds to its ask |
| `roles.<role>.skills`, `.preload`, `.context`, `.thinking` | the file's | Replace the file's values |
| `limits.maxTurns`, `.maxMinutes`, `.maxCost` | 40, 30, 2 | Limits for every role |
| `approvals`, `roles.<role>.approvals` | `forward` | `forward` or `deny` |
| `maxRunning`, `maxStarted`, `approvalWaitMinutes`, `maxAsks` | 4, 30, 30, 10 | Counts and waits |
| `folders`, `env` | none | More folders of agent files; extra variable names for children |
| `branch` | `agent/{name}` | The branch of a worker's worktree; `{name}` is the child's name |

An unknown field is an error, as in `jig-core`, and so is `writes` or `tools` under a role: they are the file's.

- **Thinking, strongest first:** `roles.<role>.thinking`, the `:level` on the model (`provider/id:low`), then the file's.
- **A company plugin** sets `roles.scout.model` and the like through `jig-core`'s section defaults. Its `ask` and yours add up.

[Design](docs/design.md#configuration) has the ranges.

## Company part (in the company plugin)

- which model each role uses, limits that fit its prices, a folder of its own roles (`agents.folders`) and the
  variable names its model provider needs in a child (`agents.env`), through `jig-core`'s section defaults;
- skills of its own, each with `metadata: jig-tool:` naming the tool it extends, so a role sees it with that tool;
- a hold in its workflow files on `subagent start`, such as until the plan is approved.

## Later

- **Structured verdicts** for `jig-workflow`: a reviewer answers PASS or FAIL in a form the review stage can read.
- **`ask_parent`:** a tool for a child to put a question to the parent agent.
- **A live view of a child:** a panel in Pi, and a terminal pane when tmux is there, that follows a child's transcript.
- **A `memory` field:** a role that keeps notes between runs. Left out until the narrowing has been used, because
  it needs a rule for what a child may remember and who may write it.
- **Measuring delegation:** whether the agent delegates when it should, and what a child costs against doing it itself.
- **A worktree made through `jig-git`,** and a **cost cap for the whole session**.

## Layout

```text
jig-agents/
  src/      index (factory), runtime + start-plan (the session's children; what a start works out), child (one child)
            with child-process, child-questions, child-report and child-types, rpc, forward (questions), limits,
            launch (flags, environment, model), roles + policy (an agent file; configuration laid over it), role-plan +
            role-report (what a role comes to; /agents roles), role-gate (the child enforces it), skills, config,
            commands, tool, watch, worktree, store + orphans, host, clean
  agents/   scout.md, reviewer.md, worker.md; skills/subagent/SKILL.md: when to delegate
  test/     one file per module; world.ts runs a parent session with a fake child, real-pi.test.ts a real Pi
  docs/     the detail pages below
```

## More detail

- [Code map](docs/code-map.md): every file, who calls it, and a child followed from `start` to its report
- [Options](docs/options.md): the Pi store's packages compared, how others specialise a subagent, and what the earlier harness taught
- [Design](docs/design.md): launch, the role's policy, approvals, limits, results, configuration, tests
- [Not verified](docs/not-verified.md): what only a real model run can show
