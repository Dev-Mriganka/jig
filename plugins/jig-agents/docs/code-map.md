# jig-agents: code map

Every file of `src/`, what it does and who calls it, and then one real call, `subagent start` to the child's report,
followed through the files. Read it with the code open: it is the shortest way to learn where things are. Back to the
[jig-agents overview](../README.md).

## The files

A test (`plugins/jig-core/test/code-maps.test.ts`) fails when a file of `src/` is missing here or a file listed here is gone,
so this table cannot drift from the code.

### Entry

| File | What it does | Called by |
|---|---|---|
| `index.ts` | The factory: registers the section, the tool, the watch kind, the command, the role gate and the session hooks | Pi, which loads it |

### Tool and commands

| File | What it does | Called by |
|---|---|---|
| `tool.ts` | The `subagent` tool: checks the input, classifies the call, runs `start`, `status`, `message`, `stop` | `index.ts` |
| `commands.ts` | `/agents`: the children, the roles, a transcript, and `say` and `stop` typed by you | `index.ts` |
| `role-report.ts` | `/agents roles`: each role as it would run here, with where every value came from | `commands.ts` |
| `watch.ts` | The `subagent` watch kind that carries a child's report, and which watch belongs to which child | `index.ts`, `runtime.ts` |

### Domain logic

| File | What it does | Called by |
|---|---|---|
| `runtime.ts` | The session's children: start, steer, resume, stop, count, and find the ones an earlier session left | `index.ts`, `tool.ts`, `commands.ts`, `watch.ts` |
| `start-plan.ts` | What a start works out first: name, id, folder, model, required commands, the task text | `runtime.ts` |
| `child.ts` | One child: its state, events, limits and end; a child ends once, in `conclude` | `runtime.ts`, `watch.ts` |
| `child-report.ts` | Which end a run was, the outcome line, `report.md`, and the result a watch hands the agent | `child.ts` |
| `child-questions.ts` | A child's questions: refuse or forward them, and count the time you kept it waiting | `child.ts` |
| `limits.ts` | The arithmetic of turns, minutes and cost, and the grace after a limit | `child.ts`, `child-report.ts` |
| `roles.ts` | Reads the agent files (the roles) from the three places they may live, field by field | `index.ts`, `runtime.ts`, `tool.ts`, `launch.ts`, `start-plan.ts`, `policy.ts`, `role-plan.ts` |
| `policy.ts` | A role with configuration laid over it: what limits the child only narrows, what it reads is replaced; the policy the child enforces | `role-plan.ts`, `role-report.ts` |
| `role-plan.ts` | What a role comes to in this session: its policy, its skills, its prompt with the preloaded ones, and what stops it from running | `runtime.ts`, `role-report.ts` |
| `skills.ts` | Which skills a child sees: Pi's list, the plugin each belongs to, the `metadata` field, preloading | `role-plan.ts` |
| `role-gate.ts` | In the child: reads the policy from the environment and registers the `jig-core` gate that enforces it | `index.ts` |
| `config.ts` | The `agents` section of `jig.json`: limits, models, counts, waits and a role's narrowing and reading | `index.ts`, `runtime.ts`, `launch.ts`, `roles.ts`, `limits.ts`, `policy.ts`, `skills.ts`, `role-report.ts` |
| `launch.ts` | The child's command line, its environment, its model, and the check of a started child | `runtime.ts`, `child.ts`, `start-plan.ts`, `tool.ts`, `role-plan.ts` |
| `worktree.ts` | A worker's own git worktree, made through `jig-core`'s `exec.git` | `runtime.ts` |

### I/O

| File | What it does | Called by |
|---|---|---|
| `child-process.ts` | The operating-system process of a child: start, end events, stderr tail, gentle stop | `child.ts` |
| `rpc.ts` | The client for Pi's RPC mode: strict JSON lines, commands matched to responses by id | `child.ts`, `forward.ts` |
| `forward.ts` | Brings a child's question to your screen, one at a time, and turns your answer into a reply | `child-questions.ts` |
| `store.ts` | The run folder of each child: `meta.json`, `system-prompt.md`, `report.md` | `child.ts`, `runtime.ts`, `orphans.ts` |
| `orphans.ts` | Stops a child that outlived its parent; in a child, notices that its parent is gone | `runtime.ts` |
| `host.ts` | Everything outside the plugin: which Pi to run, the process table, the clock, the environment | `index.ts`, `runtime.ts`, `child.ts`, `child-process.ts`, `rpc.ts` |

### Helpers

| File | What it does | Called by |
|---|---|---|
| `child-types.ts` | The shapes of a child: its spec, its outcome, its snapshot. Types only | `child.ts`, `child-report.ts`, `runtime.ts` |
| `clean.ts` | Removes terminal control sequences from text a child wrote, and shortens it for display | every file that shows a child's text |

## How a call flows: `subagent start` to the report

The agent asks for a scout: `subagent start` with `role: "scout"` and a task. These are the steps, in order.

1. **The gate.** `jig-core`'s `tool_call` hook asks `classify` in `tool.ts` where the call acts. It is a local
   write, which the rules allow, so nothing is asked.
2. **The tool.** `execute` in `tool.ts` checks the input again with `checkInput` and calls `Runtime.start` in
   `runtime.ts`.
3. **The checks before anything exists.** `start` refuses a child's own attempt to start children, a session that
   ends after one answer, an unknown role (`roles.ts`), a bad task, too many running or started children
   (`config.ts` settings), and a bad `cwd`. `start-plan.ts` makes the name and the id, finds the folder with
   `resolveCwd`, and picks the model with `modelFor` (which asks `launch.ts`).
   Then `planRole` in `role-plan.ts` lays configuration over the role (`policy.ts`), works out the skills it
   sees (`skills.ts`) and its prompt, and refuses a role that cannot run here: `bash` with no sandbox, a skill
   the session lacks, an action its tool does not have.
4. **The spec.** `start` builds a `ChildSpec` (`child-types.ts`) with the role's limits and approvals from
   `config.ts`, a run folder from `store.ts`, and a new `Child`. A role that writes first gets a git worktree of
   its own from `worktree.ts`.
5. **The launch.** `Runtime.run` builds the flags and the environment in `launch.ts` (`flagsFor`,
   `childEnvironment`, which sets `JIG_ROLE_POLICY`), then calls `Child.launch`. That starts Pi in RPC mode
   through `child-process.ts`, opens the pipes with `rpc.ts`, and asks the child which commands it lists and
   which model it runs. `checkStarted` in `launch.ts` refuses a child that did not load the same plugins or
   runs another model. In the child, `index.ts` has already called `installRoleGate` in `role-gate.ts`, which
   reads the policy and registers the gate that refuses what the role does not allow; a policy it cannot read
   makes `session_start` throw, which `checkStarted` reads as a plugin that failed to load.
6. **The task.** `Child.launch` sends the task, wrapped by `taskPrompt` in `start-plan.ts`, as the first prompt.
   The state becomes `running` and a one-second tick begins to look at the limits.
7. **The watch.** `Runtime.start` starts a watch of kind `subagent` through `ChildWatches` in `watch.ts`, and
   `execute` returns "Started scout-1 ..." to the agent at once. The agent does not poll.
8. **While it works.** Each Pi event reaches `Child.onEvent`. A finished turn adds to the counters, and `tick`
   asks `limits.ts` whether a limit is reached. A question from the child goes to `Questions.onRequest`
   in `child-questions.ts`, which refuses it or sends it to your screen through `forward.ts`.
9. **The end.** Pi reports the run as settled. `Child.settled` asks `settledPlan` in `child-report.ts` which end
   it was, and `conclude` fetches the child's last message, builds the outcome with `outcomeFor`, writes
   `report.md` (`reportText` and `store.ts`), saves the final `meta.json`, and closes the process.
10. **The report.** `jig-core`'s watch engine polls the watch every few seconds. The poll in `watch.ts` calls
    `Child.result`, which is `watchResult` in `child-report.ts`. The engine cleans the text, and sends it to the
    agent as one message that starts a turn.

If the parent dies before step 9, the child's input closes and Pi in RPC mode shuts down by itself. At the next
session start `orphans.ts` finds a child still recorded as running whose parent is gone, and stops it.

Back to the [jig-agents overview](../README.md).
