# jig-agents: child agents that Jig's rules still govern

**Status: design.**

`jig-agents` lets the agent hand work to **child agents**. A child is a separate Pi
process that loads the same plugins as its parent, so `jig-core` governs its tool calls
and `jig-sandbox` its `bash`.

When a child's rules say "ask", the question comes to your screen, labelled with the
child's name, and your answer goes back. Each child has limits on turns, minutes and
cost, and its report reaches the parent without polling.

For example, the agent starts a `scout` with the task "find where `orders-api` rounds
order totals" and carries on. When the scout finishes, its report arrives as a message.

![The agent starts a child through jig-agents, which runs a separate Pi in RPC mode with the same plugins, sends it the task, counts its limits, brings its questions to your screen and your answers back, and delivers its report as a message](../../docs/img/agents-rpc.svg)

*How a child runs. The child is a full Pi with the same plugins, so Jig's rules govern it; its questions come to you through the parent, and its report comes back without polling.*

## The decision

Jig builds this plugin itself, small, on Pi's own RPC mode, and adopts no package. Of the
Pi store's subagent packages, none keeps every child under `jig-core` and `jig-sandbox`,
sends a child's questions through `jig-core`'s own dialogs to your screen, and limits
turns, time and cost.

What decides those things sits in each package's launch code, which a plugin around it
cannot change. The comparison is in [Options](docs/options.md), and the reasons are in
[the decision entry](../../docs/decisions.md#2026-10-31-jig-agents-is-built-by-us-on-pis-rpc-mode).

## Tool: `subagent`

| Action | Kind | What it does |
|---|---|---|
| `start` | local write | Starts a child from a role and a task, and returns at once |
| `status` | read | This session's children: state, turn, minutes, cost, questions waiting |
| `message` | local write | Steers a running child, or resumes a finished one in a new process |
| `stop` | local write | Stops a child and returns its partial report |

`start` takes a `role`, a `task`, and optionally a `name` and a `cwd` inside the parent's
folder. It takes no model and no tool list: those come from the role and configuration.

| Command | What it does |
|---|---|
| `/agents` | The children of this session and any problem; `/agents roles` lists the roles |
| `/agents show <id>` | The last lines of a child's transcript |
| `/agents say <id> <text>`, `/agents stop <id>` | `message` and `stop`, typed by you |

## Roles and agent files

A **role** is an agent file: Markdown with a name, a description the parent agent reads,
the tools the child may use, and a prompt. Three ship with the plugin.

| Role | May write | For |
|---|---|---|
| `scout` | no | Exploring code, logs and tickets; reports findings with evidence |
| `reviewer` | no | Reviewing a diff or branch with fresh eyes; changes nothing |
| `worker` | yes | One scoped change, in a worktree of its own, tested |

```markdown
---
name: scout
description: Read-only exploration of code, logs and tickets, with evidence
tools: read, grep, find, ls, git, logs
writes: false
---

You explore and report. Every claim cites a file and line, a log line or a ticket key.
```

- **No model and no limits in the file.** They come from [configuration](#configure), so
  a public agent file never names a company's model.
- **`tools` only narrows.** A role that does not write must not list `bash`, `write` or `edit`.
- **Read from three places:** the plugin's `agents/`, the folders in `agents.folders`, and
  `~/.pi/agent/agents/`. Never from the project, because the model can write there. A bad
  file is skipped, and `/agents roles` names it and the field.

## Approvals in a child

A child asks through `jig-core` as its parent would. Pi's RPC mode turns the child's
dialog into a request on its output. The parent shows it on your screen, one at a time,
under a line the plugin writes (`Subagent "scout-2" asks:`), and sends your answer back
on a pipe only the parent holds.

The agent cannot answer for itself. The pipe is not a file or a web endpoint, and each
question has a random id that the model never sees.

- **Every failure is a no.** No screen, no answer within `approvalWaitMinutes`, more than
  `maxAsks` questions, or a request the plugin cannot read: the question is cancelled,
  and the child's `jig-core` counts that as a decline.
- **The floor is decided in the child.** A yes only settles what the child's own rules
  left as "ask". "Allow for this session" ends with that child. A role set to
  `approvals: "deny"` never forwards.

[Design](docs/design.md#approvals-in-a-child) has the path, the checks and the attacks considered.

## Limits

| Limit | Default | How it is counted |
|---|---|---|
| `maxTurns` | 40 | The parent counts the child's finished turns |
| `maxMinutes` | 30 | Wall clock, not counting time spent waiting for you |
| `maxCost` | 2 | US dollars Pi reports for the child, checked after each turn |

At a limit the child is told to write its report from what it has, gets two more turns or
minutes, and is then aborted. The report says which limit stopped it. Cost is bounded only
for a model that Pi prices, and there is no "no limit" setting.

## Rules

- **Never fewer extensions.** The plugin builds each child's command line and never passes
  `--no-extensions` or `-e`. A child that does not list `jig-core`'s commands is stopped.
- **One writer per folder.** A role that may write runs in a worktree other than the parent's.
- **No orphans.** A child ends when its parent session does, for any reason.
- **Few children.** `maxRunning` (4) at once, `maxStarted` (30) per session, none started by a child.

## Configure

In `~/.pi/agent/jig.json`, under `agents`. Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `roles.<role>.model` | the parent's | `provider/id`, with `:thinking` if wanted; must be in `enabledModels` |
| `roles.<role>.maxTurns`, `.maxMinutes`, `.maxCost` | `limits` | Limits for one role |
| `limits.maxTurns`, `.maxMinutes`, `.maxCost` | 40, 30, 2 | Limits for every role |
| `approvals`, `roles.<role>.approvals` | `forward` | `forward` or `deny` |
| `maxRunning`, `maxStarted`, `approvalWaitMinutes`, `maxAsks` | 4, 30, 30, 10 | Counts and waits |
| `folders`, `env` | none | More folders of agent files; extra variable names for children |

```json
{
  "agents": {
    "roles": {
      "scout": { "model": "provider/small-model:low", "maxTurns": 30 },
      "reviewer": { "model": "provider/large-model:high" }
    }
  }
}
```

An unknown field is an error, as in `jig-core`. [Design](docs/design.md#configuration) has the ranges.

## Company part (in the company plugin)

- which model each role uses, and limits that fit its prices, through `jig-core`'s
  section defaults;
- a folder of its own roles inside the plugin, such as one that knows its services;
- environment variable names its model provider needs in a child.

## Later

- **A live view:** an opt-in terminal pane that follows a child's transcript.
- **`ask_parent`:** a tool for a child to put a question to the parent agent.
- **A worktree made by `start`** through `jig-git`, and a **cost cap for the whole session**.

## Layout (planned)

```text
jig-agents/
  src/      tool and commands, child (launch, check, RPC), limits, forward (approvals), roles, report
  agents/   scout.md, reviewer.md, worker.md
  skills/   subagent/SKILL.md: when to delegate
  test/     unit tests, and a real Pi child with a scripted model
  docs/     the detail pages below
```

## More detail

- [Options](docs/options.md): the Pi store's packages compared, and what the earlier harness taught
- [Design](docs/design.md): launch, approvals, limits, results, roles, configuration, tests
