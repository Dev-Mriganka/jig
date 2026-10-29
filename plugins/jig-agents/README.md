# jig-agents: subagents in terminal panes

**Status: design.** If a package from the Pi store does this better, it is
used instead (see [Reuse](../../docs/reuse.md)).

## Tools

| Tool | What it does |
|---|---|
| `subagent` | Starts a child agent in its own tmux pane, from an agent file and a task |
| `subagent_message` | Sends a child a message |
| `subagent_status` | Reports the children: running, waiting, done |
| `subagent_interrupt` | Stops a child's current step |
| `subagent_done` | Lets a child report its result and finish |
| `caller_ping` | Lets a child reach the session that started it |

## Rules

- **Same rules for children.** A child is a full Pi session with the same
  plugins, so `jig-core` governs it too.
- **No approvals without a screen.** A child that cannot show a dialog has
  "ask" turned into "deny".
- **Limits.** Each child has a turn limit and a time limit.

## Agent files

Each agent file sets a role, its tools and its model. Examples are a planner, a
reviewer, a scout and a worker. Which model each role uses comes from
configuration, so no file names a company's model.

## Origin

Adapted from `HazAT/pi-interactive-subagents` (MIT).

## Layout (planned)

```text
jig-agents/
  src/      launcher, registry, tools
  agents/   planner.md, reviewer.md, scout.md, worker.md
  test/
```
