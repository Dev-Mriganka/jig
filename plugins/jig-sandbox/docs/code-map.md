# jig-sandbox: code map

Every file of `src/`, what it does and who calls it, and then one real call, a `bash` command, followed through the
files. Read it with the code open. Back to the [jig-sandbox overview](../README.md).

## The files

The plugin has a session part (`sandbox.ts` and the rules it applies), a part that runs after each command, a network
part (`network/`) and background tasks (`background/`). There is also one file outside `src/`: `broker/broker.mjs`, the
plain-JavaScript process that runs Anthropic's sandbox runtime, which `broker-client.ts` starts and talks to. A test
(`plugins/jig-core/test/code-maps.test.ts`) fails when a file of `src/` is missing here or a file listed here is gone,
so this table cannot drift from the code.

### Entry

| File | What it does | Called by |
|---|---|---|
| `index.ts` | The factory: registers `bash`, `/sandbox`, `/ps`, the section and the sandbox with `jig-core` | Pi, which loads it |

### Tools and commands

| File | What it does | Called by |
|---|---|---|
| `bash.ts` | The `bash` tool that replaces Pi's: wraps the command, runs it, cleans the output, explains a block | `index.ts` |
| `outside.ts` | Running one command outside the sandbox, only after `jig-core` has asked you | `bash.ts`, `commands.ts`, `index.ts` |
| `commands.ts` | `/sandbox`: status, doctor, off and on, and the folders and hosts you allowed | `index.ts` |
| `doctor.ts` | `/sandbox doctor`: checks each requirement, then proves it with real commands inside | `commands.ts` |
| `background/tools.ts` | `bash` gains `background`; `bg_output`, `bg_list` and `bg_kill` read and stop the tasks | `bash.ts`, `index.ts` |
| `background/declarations.ts` | How the three background tools are classified for `jig-core` | `index.ts` |
| `background/ps.ts` | `/ps`: the tasks of this session, their output as it grows, and stopping one | `index.ts` |

### The sandbox of a session

| File | What it does | Called by |
|---|---|---|
| `sandbox.ts` | The session's sandbox: the broker, the state, the rules for each command, `prepare` and `capture` | `aftermath.ts`, `background/tasks-deps.ts` and 4 more |
| `sandbox-types.ts` | The shapes it is built from and hands out: its state, its inputs, what `prepare` returns | `aftermath.ts`, `background/types.ts` and 4 more |
| `sandbox-setup.ts` | The session's private folders and the base configuration given to the runtime | `sandbox.ts` |
| `sandbox-messages.ts` | The words of a refusal, an error and a hint, as plain functions | `sandbox.ts` |
| `broker-client.ts` | Pi's side of the broker: starts it, sends requests over its pipe, stops it | `index.ts`, `sandbox-types.ts`, `sandbox.ts` |
| `programs.ts` | Finds bubblewrap, socat and ripgrep, or says what to install | `doctor.ts`, `network/wiring.ts` and 2 more |
| `config.ts` | The `sandbox` section of `jig.json` | `background/tasks-deps.ts`, `background/tasks.ts` and 9 more |

### The rules

| File | What it does | Called by |
|---|---|---|
| `rules.ts` | The rules as data: which paths are hidden, locked or ask-first, and what the runtime is told | `ask.ts`, `audit.ts` and 5 more |
| `lists.ts` | The exact lists of hidden, locked and ask-first paths, with the reason for each group | `gitconfig.ts`, `rules.ts` |
| `repos.ts` | The repositories the sandbox watches: hooks locked, configuration audited | `audit.ts`, `rules.ts` |
| `files.ts` | The file system as the rules look at it, so a test can give them a machine that does not exist | `audit.ts`, `index.ts` and 6 more |
| `pathing.ts` | Small POSIX path helpers for the rules | `ask.ts`, `audit.ts` and 6 more |
| `platform.ts` | Facts about the machine that the rules depend on | `index.ts` |
| `env.ts` | The environment a command starts with: Pi's, without anything credential-shaped | `sandbox.ts` |

### After a command

| File | What it does | Called by |
|---|---|---|
| `aftermath.ts` | What follows a command: the audit of what it created, and the lines that say which rule stopped it | `background/after-end.ts`, `background/tasks-deps.ts` and 2 more |
| `audit.ts` | What the runtime cannot prevent, undone and reported: files planted where no rule could reach | `aftermath.ts` |
| `gitconfig.ts` | A git configuration read just enough to find settings that run a program or redirect a remote | `audit.ts`, `repos.ts` |
| `explain.ts` | Reads a block back from the command's own error lines and matches it to a rule | `aftermath.ts` |
| `ask.ts` | Asking you about a write to an ask-first folder, after the command, inside the waiting call | `aftermath.ts`, `index.ts` |
| `allowed.ts` | What you allowed: folders and hosts, for the session or always | `ask.ts`, `commands.ts` and 4 more |
| `output.ts` | Makes a command's output safe to show: no terminal control sequences, no credential values | `background/capture.ts`, `bash.ts` |

### The network (network/)

| File | What it does | Called by |
|---|---|---|
| `network/policy.ts` | The decision about one connection: allow it, refuse it with a reason, or ask you | `network/ask-host.ts`, `network/wiring.ts` and 2 more |
| `network/hosts.ts` | Host patterns as `network.allow` and `network.deny` write them | `allowed.ts`, `commands.ts` and 2 more |
| `network/addresses.ts` | What an address or a host name is, and which addresses must never be reached | `commands.ts`, `network/hosts.ts`, `network/policy.ts` |
| `network/ask-host.ts` | Asking you about a host in `ask` mode, while the connection waits | `network/wiring.ts`, `sandbox-types.ts`, `sandbox.ts` |
| `network/bridge.ts` | Carries `localhost` ports of tasks and listed services into each command's own network | `network/wiring.ts`, `sandbox-types.ts`, `sandbox.ts` |
| `network/wiring.ts` | Builds the host questions, the bridge and the policy from what the sandbox gives them | `sandbox.ts` |

### Background tasks (background/)

| File | What it does | Called by |
|---|---|---|
| `background/tasks.ts` | The registry of tasks: start, stop, limits, deadlines, listeners and the end of the session | `background/ps.ts`, `background/tools.ts` and 2 more |
| `background/tasks-deps.ts` | What the registry is given and asked: its dependencies, a start request, a stop report | `background/task-record.ts`, `background/tasks.ts`, `index.ts` |
| `background/task-record.ts` | A task's record, made when it starts running or when its process could not be created | `background/tasks.ts` |
| `background/capture.ts` | Captures what a task prints into its log and its matcher, and says once when it is over | `background/tasks.ts` |
| `background/after-end.ts` | The audit and the explanation after a task's process is gone | `background/tasks.ts` |
| `background/patterns.ts` | The patterns that wake the agent: checked before the task starts, matched against its lines | `background/tasks.ts`, `background/tools.ts`, `background/types.ts` |
| `background/notify.ts` | Waking the agent: task events become messages, and a noisy build is one message | `background/tasks-deps.ts`, `background/tasks.ts` |
| `background/logfile.ts` | A task's output on disk: a rotating writer with offsets that stay valid | `background/output.ts`, `background/tasks.ts`, `background/types.ts` |
| `background/output.ts` | What the agent and `/ps` read of a log: paged, filtered and capped | `background/after-end.ts`, `background/notify.ts` and 3 more |
| `background/process.ts` | The only contact with processes: signals and `/proc`, behind an interface a test can fake | `background/sessions.ts`, `background/tasks-deps.ts` and 2 more |
| `background/sessions.ts` | What a session keeps on disk for its tasks, and how a crashed session's leftovers are found | `background/tasks.ts` |
| `background/env.ts` | The environment a background command starts from, as Pi's own bash would give it | `background/tasks.ts` |
| `background/format.ts` | The words for a task, shared by the tools, `/ps` and the wake-up messages | `background/notify.ts`, `background/output.ts` and 4 more |
| `background/types.ts` | The shapes the background module shares. Types only | `background/after-end.ts`, `background/capture.ts` and 9 more |

## How a call flows: one `bash` command

The agent runs `npm test` with `bash`. Steps 6 and 9 differ by network mode; they are described for `ask`.

1. **The class.** `jig-core` classifies `bash` as a local write, and its rules allow it: the sandbox is the protection,
   and rules for `bash` are a convenience on top. The call reaches the `bash` tool that `index.ts` registered, which is
   `bash.ts`, not Pi's own.
2. **The operations.** `bash.ts` builds Pi's own bash tool with its own operations (`sandboxedOperations`), so Pi keeps
   its streaming, truncation and time limits. Only where the command runs changes.
3. **Prepare.** `exec` calls `Sandbox.prepare` in `sandbox.ts`. It waits until the session's start has finished, and
   refuses with the steps to fix it if the sandbox is unavailable or off (`sandbox-messages.ts`). A command never runs
   bare because something went wrong.
4. **The rules.** `wrap` asks `rulesFor` for the rules of this working folder. `rules.ts` computes them from
   `lists.ts` (the exact lists), `repos.ts` (the repositories around the folder), `files.ts` (a view of the file
   system) and the protected paths `jig-core` gave: which paths are hidden, locked or ask-first.
5. **The environment.** `env.ts` gives the command a copy of Pi's environment without anything credential-shaped, and
   hands back the values it removed, so that they can be cut from the output if they show up.
6. **The broker.** `wrap` sends the command and the rules to the broker (`broker-client.ts`, then `broker/broker.mjs`
   and the runtime) and gets back the wrapped command: a bubblewrap invocation on Linux. In `filtered` and `ask` modes
   the bridge (`network/bridge.ts`) first adds forwarders for the `localhost` ports a command may reach.
7. **Before.** `Aftermath.before` (`aftermath.ts`) takes a snapshot for the audit (`audit.ts`).
8. **The run.** Pi's local operations run the wrapped command with the clean environment. What it prints goes through
   `output.ts`, which strips terminal control sequences and credential values, and on to the model.
9. **A connection.** In `ask` mode only, the first connection to a new host reaches the broker's proxy, which asks the
   broker, which asks Pi: `Sandbox.onBrokerEvent` calls `network/policy.ts`, which refuses blocked addresses and
   otherwise asks you through `network/ask-host.ts`. The command waits for the answer.
10. **After.** When the command ends, `prepared.finish()` collects the runtime's violations. `Aftermath.after` runs
    `audit.ts` (what the command planted where no rule could stop it is undone and reported), `explain.ts` (a block is
    read back from the command's own error lines and matched to a rule) and, for a refused write under an ask-first
    folder, `ask.ts`, which asks you inside the waiting call.
11. **The lines.** The `[sandbox]` lines that say which rule stopped the command go after its output. `jig-core` then
    redacts, masks and caps the result as for any tool, and records the call.

The same path starts a background task, except that `background/tasks.ts` spawns the wrapped command itself, so that
it can wait for the task across turns, and wakes the agent when it ends.

Back to the [jig-sandbox overview](../README.md).
