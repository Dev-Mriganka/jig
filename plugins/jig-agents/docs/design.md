# Design

How `jig-agents` starts a child, how a child's questions reach you, how its limits and
its report work, and how it will be tested. Back to the [jig-agents overview](../README.md).

## Principles

1. **A child is Pi, not a copy of Pi.** It is the same program with the same plugins and
   the same `jig.json`, so every rule that governs the parent governs the child, and a
   new plugin is covered the day it is installed.
2. **The parent owns the child's process and pipes.** What must be trusted (the limits,
   the answers to questions, the stop) is decided in the parent, out of the child's reach.
3. **Every failure is a no.** An answer that cannot be delivered, a check that cannot
   run, a message that cannot be read: the child is refused, cancelled or stopped.
4. **Small.** Pi supplies the protocol, the session files, `abort` and `steer`;
   `jig-core` supplies the watch engine that returns results. The plugin adds policy. The
   estimate is about 1,000 lines and no dependency.

## One child, end to end

```text
agent calls subagent {action: "start", role: "scout", task: "..."}
  -> jig-core's rules (subagent start: a local write, allowed by default)
  -> jig-agents, in the parent
       check    role, cwd, counts, writer lock, model (configuration, then enabledModels)
       launch   Pi's own program with --mode rpc; stdin and stdout are pipes
       verify   get_commands lists jig-core's commands, or the child is stopped
       prompt   the task, the report format and the limits, as one prompt command
       watch    a jig-core watch of kind "subagent"; the tool returns at once
  <- tool result: the child's id, role, model and limits

the child runs: its own jig-core and jig-sandbox govern every call it makes
  question  select or input request on stdout -> the parent's screen -> response on stdin
  progress  turn_end and message events on stdout -> the parent counts turns and minutes;
            get_session_stats after each turn gives the cost
  limit     steer "wrap up" -> abort -> end stdin -> end the process group
  settled   agent_settled on stdout

the parent: get_last_assistant_text -> report.md -> the watch finishes
  -> jig-core's watch engine cleans the text and sends one follow-up message that starts a turn
  -> stdin is closed, and the child shuts down
```

## Launch

The plugin builds the command line from fixed parts. Nothing in an agent file, a tool
call or the project reaches it as a flag.

| Flag | Why |
|---|---|
| `--mode rpc` | Dialogs, events, `abort` and `steer` as documented JSON lines |
| `--session-id agent-<id>` | A session file Pi lists, `message` can resume, and `/lens usage` counts once |
| `--model`, `--thinking` | From configuration, after the check against `enabledModels` |
| `--tools <list>` | The role's list, which can only narrow |
| `--exclude-tools subagent,mcp__*` | No children of children; no MCP tools unless the role names one |
| `--append-system-prompt <file>` | The role's prompt, from a file in the run folder |
| `--no-approve` | A `.pi/` folder the model wrote in the project does not load in the child |

**Never passed:** `--no-extensions`, `-ne`, `-e`, `--extension`, `--approve`. A test
reads the command line the plugin builds and fails if any of them can appear.

- **Which Pi.** The same program as the parent (`process.execPath` and Pi's own entry
  file), not whichever `pi` comes first on `PATH`, which may be a wrapper. A single
  compiled Pi has no entry file, and `process.execPath` alone is used; that is not checked.
- **Working folder.** `cwd` must be inside the parent's working folder, because the
  sandbox makes the working folder writable and a wider one would widen the child.
- **Environment.** A list of names: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`,
  `TZ`, `LANG`, `LC_*`, `XDG_*`, `PI_*`, proxy and certificate variables, and the names
  in `agents.env`. Any other name is left behind, a key, token or password included;
  Pi's own login in the agent folder needs no variable. The child gets `PI_SUBAGENT_ID`,
  which `jig-theme` and `jig-review` already read.
- **The task** goes in a `prompt` command on stdin, not on the command line, so it does
  not show in `ps`. The run folder is created with private permissions.
- **Process group.** The child leads its own group, so a stop can end its descendants,
  such as the sandbox broker.

## Checking the child at start

Before the task is sent, the plugin sends `get_commands` and `get_state` and checks:
- the commands of `jig-core` are listed, and those of `jig-sandbox` when the parent has it;
- the model is the one configured;
- no `extension_error` arrived.

A child that fails is stopped and `start` says why. This catches a Pi that could not load
its plugins, for example because of a broken settings file, which would run ungoverned.

## Approvals in a child

### The path

1. The child's `jig-core` decides "ask". In RPC mode `ctx.hasUI` is true, so it asks
   with Pi's selector, as it does for any host without a terminal interface
   ([What asks](../../jig-core/docs/approval-screens.md#the-screens)).
2. Pi writes `extension_ui_request` with a random id (`crypto.randomUUID()`) on stdout.
3. The parent checks it and queues it behind other children's questions.
4. The parent asks you with its own `ctx.ui.select` or `input`, under a header it writes.
5. Your answer becomes `extension_ui_response` with the same id, written to stdin.
6. The child's `jig-core` reads the answer inside the waiting call. A cancelled request
   reaches it as no answer, which it records and treats as a decline.

### What the screen shows

```text
Subagent "worker-1" (worker) asks. The text below comes from the child. (1 more waiting)
  git  push  external  write
  Push feature/PROJ-123 to origin
  Allow
  Allow for this subagent
  Decline
```

- **The first line is the plugin's.** The child's text follows, indented, so it cannot
  pass as a header.
- **The text is cleaned:** control characters and terminal escape codes removed, each
  line cut at 200 characters, at most 30 lines, with a note where it was cut.
- **Options pass through unchanged,** at most 5 of at most 100 characters each, except
  that the stock "Allow for this session" is shown as "Allow for this subagent" and
  mapped back. A request with more or longer options is cancelled.

### What is forwarded

| Request | What the parent does |
|---|---|
| `select`, `confirm`, `input` | Shows it as above, and answers |
| `editor` | Cancels it. No Jig plugin uses it |
| `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` | Ignores them. They are free text from the child |
| A request with a missing or repeated id, or from a child that has finished | Ignores it |

### Every failure is a no

The request is cancelled, and nothing is allowed, when:
- the parent has no screen (`ctx.hasUI` is false, as in a program that embeds Pi without one);
- the role's `approvals` is `deny`;
- the child has already asked `maxAsks` times;
- no answer comes within `approvalWaitMinutes`, or the parent's run is aborted;
- the request does not parse, or the plugin throws while handling it.

A parent that is itself an RPC host passes the question on to its own host. The root
screen decides, and a root without a screen cancels.

### Attacks considered

| Attack | Why it does not work |
|---|---|
| The child's `bash` writes an answer to its own input | The id is random and never reaches the model; `bash` is sandboxed. Test it |
| The child's text imitates the plugin's header | The header is the first line and the child's text is indented and cut |
| A flood of questions wears you down | After `maxAsks` they are cancelled; each waits at most `approvalWaitMinutes` |
| The parent agent answers through `message` | `message` sends a user message; it never answers a dialog |
| One child pretends to be another | The label is the registry's name for the process that sent the request |
| The child changes what it asked after you saw it | An answer is for one id; a tool compares the approved preview with what it runs |
| A question arrives while the parent's own is on screen | The queue shows one at a time; Pi 1.4 also keeps both dialogs rather than losing one |
| Allowing in a child lowers the floor | The floor is decided in the child's `jig-core`; a yes only settles an "ask" |

### Why this fits "inside the waiting call"

[Approvals](../../../docs/approvals.md) say you answer inside the waiting call so that
no token exists that the agent could reuse. Here the child's tool call is the waiting
call. The answer is typed in Pi, and travels as a reply to one random id on a pipe that
only the parent process holds. There is no file, no web endpoint and no cookie.

That page lists "Approving from another session" under *Later*; this is that, for
children. When this is built, that page gets a line about it.

The forwarded question shows what the child's `jig-core` shows a host without a terminal
interface: the first 20 lines of a long preview, and "(the rest is not shown here)".
For a long diff, decline and ask for the full text in the report.

The alternative that was read, `@gotgenes/pi-permission-system`'s forwarding, carries
answers through files in Pi's session folder. A pipe is stronger: a file can be written
by anything that can write the folder.

## Limits

| Limit | Measured by | Checked |
|---|---|---|
| Turns | `turn_end` events: one reply and its tool calls | At each turn end |
| Minutes | A monotonic clock from the first prompt, minus time spent on your answers | By a timer, even in a long tool call |
| Cost | `cost` from `get_session_stats`, which includes tool-reported usage | After each turn and at the end |

- **The stop, in order:**
  1. a `steer` message: the limit is reached, write the final report from what you have,
     start it with "Stopped at the limit", and list what is unknown;
  2. two more turns or two more minutes, whichever comes first;
  3. `abort`, and a wait of 5 seconds;
  4. stdin is ended, with a wait of 5 seconds;
  5. SIGTERM to the process group, and SIGKILL 5 seconds later.
- **The report is partial** and says which limit stopped it. The outcome carries it too.
- **Cost can overrun by one turn,** because it is known only after the reply. The earlier
  harness checked time only at a turn end, so a ten-minute tool call overran its
  minutes; here a timer fires.
- **An unpriced model reports no cost.** Then `status` shows "cost unknown" and only
  turns and minutes bound the child. Tokens as a cap are under *Later*.
- **A resumed child gets a fresh budget,** and counts again toward `maxStarted`.
- **Ranges:** turns 1 to 500, minutes 1 to 480, cost above 0 up to 100. There is no "no
  limit".

## Results

A child is a watch of kind `subagent` in `jig-core`'s [watch engine](../../jig-core/docs/watches.md).
That gives the parent its result without polling and without new code:

- **One follow-up message that starts a turn,** combined and spaced with other results.
- **Cleaning:** escape codes removed, secrets redacted, personal data masked, text cut.
- **The `watch` tool** lists and stops children with every other watch, and `/jig` counts them.
- **A saved record.** After a restart the first poll finds no child and ends the watch
  with `error`: "the session restarted while this child ran". `message` can resume it from
  its saved session.

`poll` only reads the plugin's own record, so it costs nothing. The engine's first poll is
about 2 seconds after the start, and later ones are 5 seconds apart at least.

| The child | Outcome | Summary |
|---|---|---|
| Finished by itself | `passed` | Turns, minutes, cost; the path of the full report |
| Stopped at a limit | `failed` | Which limit; the partial report |
| Ran out the engine's backstop | `timed-out` | The same |
| Stopped by `stop` | `stopped` | Nothing is sent |
| Died, or could not start | `error` | The last stderr lines, cleaned |

The words are the engine's, and `passed` reads oddly for a scout. A `finished` outcome is
a small change in `jig-core`, and can come later. The backstop is `maxMinutes` + 10 +
`maxAsks` × `approvalWaitMinutes`, so waiting for you never makes it fire first.

- **The message shows the first 10 detail lines,** an engine limit. A role's prompt puts
  the answer first, and the summary names `report.md`, which holds the cleaned full text
  that the agent can `read`.
- **The report is data.** A child's text can carry what it read from a file, a log or a
  ticket. The message says so, and the parent's skill says to treat it as input.
- **No `usage` on the tool result.** `/lens usage` counts a tool result's usage and a
  session file's separately, so the child's cost is counted from its own file once.

## Roles and agent files

```markdown
---
name: worker
description: Implements one scoped change in a worktree, tests it and reports
tools: read, write, edit, bash, git
writes: true
---

You implement the one task in the parent's message, in this folder, and report.
```

| Field | Meaning |
|---|---|
| `name` | Letters, digits, `-` and `_`; defaults to the file name |
| `description` | One line the parent agent reads in the tool's role list |
| `tools` | A list of tool names that narrows; omitted means the child's usual tools |
| `writes` | `true` if the role may write; default `false` |

- **Unknown fields are errors,** and so is a `model`, `thinking`, `limits` or
  `extensions` field: those belong to configuration or are not allowed at all.
- **A role with `writes: false`** is refused if its `tools` list `bash`, `write`, `edit`,
  or a tool that `/jig rules` shows as a write.
- **Where files are read,** lowest first: the plugin's `agents/`, `agents.folders`, then
  `~/.pi/agent/agents/`. A file with an earlier name replaces it. Project folders are
  never read.
- **When the agent delegates** is one rule in the tool description: if an answer needs
  more than about five files or 20,000 tokens of output, start a scout; use `reviewer`
  for a fresh look at your own change. The earlier harness measured that its agent
  delegated only when asked, so `jig-workflow` can name `reviewer` in its review stage.
- **No interactive roles.** The earlier harness's planner talked to you in its pane. A
  child here has no screen, so planning stays with the parent, in `jig-workflow`'s plan
  stage.

## Configuration

| Field | Type and range | Default |
|---|---|---|
| `roles.<role>.model` | `provider/id` or `provider/id:thinking`, in `enabledModels` | the parent's model |
| `roles.<role>.maxTurns` / `maxMinutes` / `maxCost` | the ranges above | `limits` |
| `roles.<role>.approvals` | `forward` or `deny` | `approvals` |
| `limits.maxTurns` / `maxMinutes` / `maxCost` | the ranges above | 40 / 30 / 2 |
| `maxRunning`, `maxStarted` | 1 to 16, and 1 to 200 | 4, 30 |
| `approvals` | `forward` or `deny` | `forward` |
| `approvalWaitMinutes`, `maxAsks` | 1 to 240, and 0 to 100 | 30, 10 |
| `folders` | absolute paths of folders with agent files | none |
| `env` | extra variable names, such as one a model provider needs | none |

- **Models are checked** against `enabledModels` in Pi's global `settings.json`. Project
  settings are never read, because the model can write there. A model outside the list,
  or one Pi does not know, refuses the `start` with the allowed patterns.
- **A role in the configuration with no agent file** is a warning in `/agents roles`.
- **Company defaults** arrive through `config.addSectionDefaults("agents", ...)`, and the
  user's own section is laid over them.
- **`maxAsks` of 0** means every ask is denied, the same as `approvals: "deny"`.

## Lifecycle

- **States:** starting, running, waiting for you, then finished, stopped, failed or lost.
- **No orphans.** When the parent session shuts down, for any reason (`/new`, `/resume`,
  `/fork`, `/reload` or quit), every child is aborted and ended. If the parent dies
  without that, its pipe closes, and Pi's RPC mode shuts down when its input ends. In a
  child the plugin also checks every 10 seconds that its parent still exists. A
  `/reload` therefore ends running children; `message` resumes them from their sessions.
- **Not in a session that will end.** In print or JSON mode `start` is refused, because
  a result would have nowhere to go.
- **One writer per folder.** A `writes: true` role is refused in the parent's own folder
  and in a folder another running child writes in. It needs a worktree.
- **Run folder:** `agents/<session>/<child>/` in `jig-core`'s state folder, with
  `meta.json`, `system-prompt.md` and `report.md`. Folders older than 14 days are
  removed when a session starts. Pi's own session files are not touched.
- **Counts:** `maxRunning` children at once and `maxStarted` per session. A child has no
  `subagent` tool, so nothing nests.

## Records and the lens

- **Each child's `jig-core` writes its own records** in its own session. The record of
  the parent's `subagent` call adds the facts `role` and `child`, and never the task.
- **Each child's session file** is in Pi's usual sessions folder, so `pi -r` lists it and
  `/lens usage` counts its cost once.

## Tests

1. **Unit tests** with a fake child that speaks the protocol: role files, configuration,
   the limit arithmetic, the cleaning of forwarded text, the queue, and one case for each
   line of "Every failure is a no".
2. **A command-line test** that the launch arguments never hold an extension flag.
3. **A real Pi 1.4 child with a scripted model,** as `jig-core` does for its own hooks.
   It is the first thing built, before any other code. It proves, in order:
   - a child's "ask" reaches a fake screen and the answer comes back;
   - a child started without `jig-core` is stopped;
   - a looping child is stopped by each limit;
   - from the child's sandboxed `bash`, writing to its own input does nothing useful;
   - ending the parent ends the child;
   - two children's questions queue.

   It is skipped, with the reason, when no Pi 1.4 is installed.

## Not verified

- **Nothing has been run.** Every statement about Pi's RPC mode is from its documents
  and source, and every statement about a package is from its README and code (see
  [Options](options.md#not-verified)).
- **`jig-core` has not been run in a real RPC child.** Its tests use a fake RPC context.
- **The sandbox and the child's input.** Whether `bash` in `jig-sandbox` could reach the
  child Pi's descriptors is not established; the random id is the defence either way.
- **Secrets that prompt.** A child has no terminal, so a secret backend that asks for a
  passphrase would hang. Working with an already unlocked backend is assumed.
- **Several Pi processes and one tunnel.** Whether two children opening the same
  `jig-core` tunnel clash is not known.
- **Unpriced models.** Whether to cap by tokens instead is open.
- **The size** of about 1,000 lines is an estimate.

Back to the [jig-agents overview](../README.md).
