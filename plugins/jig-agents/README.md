# jig-agents: subagents in terminal panes

**Status: design.** If a package from the Pi store does this better, it is used
instead (see [Reuse](../../docs/reuse.md)).

`jig-agents` lets the agent hand work to child agents, each a full Pi session in
its own tmux pane. A parent starts a child from an agent file and a task, can
message or interrupt it, and the child reports its result when it finishes. For
example, a planner starts a reviewer in a new pane with the task "review the
change on this branch", and the reviewer's report comes back to the planner when
the reviewer is done.

## Tools

All six act on this machine only.

| Tool | Kind | What it does |
|---|---|---|
| `subagent` | local write | Starts a child agent in its own tmux pane, from an agent file and a task |
| `subagent_message` | local write | Sends a child a message |
| `subagent_status` | read | Reports the children: running, waiting, done |
| `subagent_interrupt` | local write | Stops a child's current step |
| `subagent_done` | local write | Lets a child report its result and finish |
| `caller_ping` | local write | Lets a child reach the session that started it |

## Rules

- **Same rules for children.** A child is a full Pi session with the same
  plugins, so `jig-core` governs it too.
- **No approvals without a screen.** A child that cannot show a dialog has
  "ask" turned into "deny".
- **Limits.** Each child has a turn limit and a time limit.

## Agent files

Each agent file sets a role, its tools and its model. Examples are a planner, a
reviewer, a scout and a worker.

## Configure (planned)

Which model each role uses comes from configuration, so no agent file names a
company's model. The fields are not designed yet.

## Company part (in the company plugin)

- which model each role uses.

## Origin

Adapted from `HazAT/pi-interactive-subagents` (MIT).

## Layout (planned)

```text
jig-agents/
  src/      launcher, registry, tools
  agents/   planner.md, reviewer.md, scout.md, worker.md
  test/
```
