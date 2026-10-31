# Design

How `jig-agents` starts a child, how a child's questions reach you, how its limits and
its report work, and how it is tested. Back to the [jig-agents overview](../README.md).

## Principles

1. **A child is Pi, not a copy of Pi.** It is the same program with the same plugins and
   the same `jig.json`, so every rule that governs the parent governs the child, and a
   new plugin is covered the day it is installed.
2. **The parent owns the child's process and pipes.** What must be trusted (the limits,
   the answers to questions, the stop) is decided in the parent, out of the child's reach.
3. **Every failure is a no.** An answer that cannot be delivered, a check that cannot
   run, a message that cannot be read: the child is refused, cancelled or stopped.
4. **Small.** Pi supplies the protocol, the session files, `abort` and `steer`;
   `jig-core` supplies the watch engine that returns results. The plugin adds policy. It
   has no dependency. The source is about 3,000 lines with its comments: the estimate of
   1,000 left out the checks, the cleaning of text and the orphan sweep.

## One child, end to end

```text
agent calls subagent {action: "start", role: "scout", task: "..."}
  -> jig-core's rules (subagent start: a local write, allowed by default)
  -> jig-agents, in the parent
       check    role, cwd, counts, model (configuration, then enabledModels), a worktree for a writer
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
| `--model`, `--thinking` | From configuration, or the parent's own, after the check against `enabledModels` |
| `--tools <list>` | The role's list, which can only narrow |
| `--exclude-tools subagent,mcp__*` | No children of children; no MCP tools unless the role names one |
| `--append-system-prompt <file>` | The role's prompt, from a file in the run folder |
| `--no-approve` | A `.pi/` folder the model wrote in the project does not load in the child |

**Never passed:** `--no-extensions`, `-ne`, `-e`, `--extension`, `--approve`, `-a`. A test
builds the command line for every shipped role and fails if any of them can appear.

- **Which Pi.** The same program as the parent: `process.execPath` and Pi's own entry
  file, found from `process.argv[1]` through any link and only when it sits in Pi's
  package. Not whichever `pi` comes first on `PATH`, which may be a wrapper. A single
  compiled Pi has no entry file, and `process.execPath` alone is used; that is not checked.
- **Which plugins.** The child reads the same agent folder as its parent, because
  `PI_CODING_AGENT_DIR` (a `PI_*` name) and `HOME` reach it. Pi then loads the packages in
  the same `settings.json`, and Jig reads the same `jig.json`. A plugin the parent got
  another way, such as `-e` on its command line or a trusted project's `.pi/settings.json`,
  is not in the child, and the check below refuses a child that lacks `jig-core` or, when
  the parent has it, `jig-sandbox`.
- **Which model.** The role's, from `agents.roles.<role>.model`; else the parent's own model
  and thinking level, passed explicitly so a model switched in the session carries over.
- **Working folder.** `cwd` must be inside the parent's working folder, because the
  sandbox makes the working folder writable and a wider one would widen the child. A role
  that writes works in a worktree instead (see [Lifecycle](#lifecycle)).
- **Environment.** A list of names: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TZ`,
  `LANG`, `TMPDIR`, `LC_*`, `XDG_*`, `PI_*`, `JIG_STATE_DIR`, `JIG_CONDITION`, proxy and certificate
  variables, and the names in `agents.env`. Any other name is left behind, a key, token or
  password included. Pi's own login in the agent folder needs no variable; a model provider
  that does, such as `AWS_PROFILE`, is named in `agents.env`.
- **Who the child is.** It gets `PI_SUBAGENT_ID`, which `jig-theme` and `jig-review` already
  read, `JIG_PARENT_SESSION` and `JIG_AGENT_ROLE`, which `jig-core`'s records already read,
  `PI_SUBAGENT_NAME`, `PI_SUBAGENT_PARENT_PID` and `PI_SKIP_VERSION_CHECK=1`.
- **The task** goes in a `prompt` command on stdin, not on the command line, so it does
  not show in `ps`. It follows a line that names the role, so it never starts with `/`
  and cannot run a command in the child. The run folder is created with private permissions.
- **Process group.** The child leads its own group, so a stop can end its descendants,
  such as the sandbox broker, and a Ctrl-C meant for the parent does not reach it.

## Checking the child at start

Before the task is sent, the plugin sends `get_commands` and `get_state` and checks:
- the commands of `jig-core` are listed, and those of `jig-sandbox` when the parent has it;
- the model is the one configured, or the parent's;
- no `extension_error` arrived.

A child that fails is stopped and `start` says why. This catches a Pi that could not load
its plugins, for example because of a broken settings file, which would run ungoverned. A
child that does not answer within 60 seconds, dies, or does not start a run for its task
is refused the same way, and a worktree made for it is taken away again.

## Approvals in a child

### The path

1. The child's `jig-core` decides "ask". In RPC mode `ctx.hasUI` is true, so it asks
   with Pi's selector, as it does for any host without a terminal interface
   ([What asks](../../jig-core/docs/approval-screens.md#the-screens)).
2. Pi writes `extension_ui_request` with a random id (`crypto.randomUUID()`) on stdout.
3. The parent reads it without trusting it, and queues it in `jig-core`'s queue behind
   its own questions and other children's (`approvals.inTurn`).
4. The parent asks you with its own `ctx.ui.select` or `input`, under a header it writes.
5. Your answer becomes `extension_ui_response` with the same id, written to stdin.
6. The child's `jig-core` reads the answer inside the waiting call. A cancelled request
   reaches it as no answer, which it records and treats as a decline.

If you decline, the child's `jig-core` asks one more thing, "Why decline?", as an `input`
request; it is forwarded the same way, and what you type reaches the child's model.

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
  pass as a header. The count is the questions waiting behind this one, from every child.
- **The text is cleaned:** control characters, terminal escape codes (CSI, OSC and string
  sequences), bidirectional overrides and zero-width marks removed, a carriage return
  turned into a line break so a line cannot be redrawn, each line cut at 200 characters,
  at most 30 lines, with a note where it was cut.
- **Options pass through,** at most 5 of at most 100 characters each, except that the
  stock "Allow for this session" is shown as "Allow for this subagent" and mapped back. A
  request with more or longer options, or two that look the same once cleaned, is cancelled.

### What is forwarded

| Request | What the parent does |
|---|---|
| `select`, `confirm`, `input` | Shows it as above, and answers |
| `editor` and any other method | Cancels it. No Jig plugin uses an editor |
| `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` | Ignores them. They are free text from the child |
| A request with a missing or repeated id, or from a child that has finished | Ignores it |

### Every failure is a no

The request is cancelled, and nothing is allowed, when:
- the parent has no screen (`ctx.hasUI` is false, as in a program that embeds Pi without one);
- the role's `approvals` is `deny`;
- the child has already asked `maxAsks` times, or four of its questions are waiting;
- no answer comes within `approvalWaitMinutes` of the request (the queue counts), or within
  the `timeout` the child gave, or the child is stopped, or the parent's run is aborted;
- the request does not parse, or the plugin throws while handling it.

A parent that is itself an RPC host passes the question on to its own host. The root
screen decides, and a root without a screen cancels.

### Attacks considered

| Attack | Why it does not work |
|---|---|
| The child's `bash` reads its questions or writes an answer on its own pipes | The pipes are UNIX sockets, which `/proc/<pid>/fd` cannot reopen (a test opens them and gets `ENXIO`); the id is random and never reaches the model; `bash` is sandboxed. Other same-user routes, such as `ptrace` where `ptrace_scope` is 0, are for the sandbox ([Not verified](not-verified.md)) |
| The child's text imitates the plugin's header | The header is the first line and the child's text is indented and cut |
| A flood of questions wears you down | After `maxAsks` they are cancelled; each waits at most `approvalWaitMinutes` |
| The parent agent answers through `message` | `message` sends a user message; it never answers a dialog |
| One child pretends to be another | The label is the registry's name for the process that sent the request |
| The child changes what it asked after you saw it | An answer is for one id; a tool compares the approved preview with what it runs |
| A question arrives while the parent's own is on screen | The queue shows one at a time; both dialogs are kept |
| Allowing in a child lowers the floor | The floor is decided in the child's `jig-core`; a yes only settles an "ask" |
| Two questions say the same words | An answer is matched by the request's id, never by text |

### Why this fits "inside the waiting call"

[Approvals](../../../docs/approvals.md) say you answer inside the waiting call so that
no token exists that the agent could reuse. Here the child's tool call is the waiting
call. The answer is typed in Pi, and travels as a reply to one random id on a pipe that
only the parent process holds. There is no file, no web endpoint and no cookie.

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
| Minutes | The clock from the first prompt, minus time spent on your answers | Every second, even in a long tool call |
| Cost | `cost` from `get_session_stats`, which includes tool-reported usage | After each turn and at the end |

- **The stop, in order:**
  1. a `steer` message: the limit is reached, write the final report from what you have,
     start it with "Stopped at the limit", and list what is unknown;
  2. two more turns or two more minutes, whichever comes first;
  3. `abort`, and a wait of 5 seconds for its answer;
  4. the partial report is read with `get_last_assistant_text`;
  5. stdin is ended, with a wait of 5 seconds;
  6. SIGTERM to the process group, and SIGKILL 5 seconds later.
- **The report is partial** and says which limit stopped it. The outcome carries it too.
  A child that finishes its report inside the grace ends at the limit without an abort.
- **Cost can overrun by the turns in flight,** because it is known only after the reply.
  The earlier harness checked time only at a turn end, so a ten-minute tool call overran
  its minutes; here a timer fires.
- **An unpriced model reports no cost.** A model counts as priced when Pi gives it a price
  or it reports a cost above zero. Otherwise `status` shows "cost unknown" and only turns
  and minutes bound the child. Tokens as a cap are under *Later*.
- **A resumed child gets a fresh budget,** and counts again toward `maxStarted`.
- **Ranges:** turns 1 to 500, minutes 1 to 480, cost above 0 up to 100. There is no "no
  limit".

## Results

A child is a watch of kind `subagent` in `jig-core`'s [watch engine](../../jig-core/docs/watches.md).
That gives the parent its result without polling and with very little new code:

- **One follow-up message that starts a turn,** combined and spaced with other results.
- **Cleaning:** escape codes removed, secrets redacted, personal data masked, text cut.
- **The `watch` tool** lists and stops children with every other watch, and `/jig` counts
  them. A watch stopped there stops its child too (the plugin listens for `jig:watch-done`).
- **A saved record.** After a restart the first poll finds no child and ends the watch
  with `error`: "the session restarted while this child ran". `message` can resume it from
  its saved session.

`poll` only reads the plugin's own record, so it costs nothing. The engine's first poll is
about 2 seconds after the start, and later ones are 5 seconds apart at least. No progress
`update` is sent: `status` shows progress when the agent wants it.

| The child | Outcome | Summary |
|---|---|---|
| Finished by itself | `passed` | Turns, minutes, cost; the path of the full report |
| Stopped at a limit | `failed` | Which limit; the partial report |
| Ran out the backstop | `timed-out` | The same: the poll itself ends it, stopping the child |
| Stopped by `stop` | `stopped` | Nothing is sent |
| Died, could not be read, or its model failed | `error` | The reason, and the last stderr lines, cleaned |

The words are the engine's, and `passed` reads oddly for a scout. A `finished` outcome is
a small change in `jig-core`, and can come later. The backstop is `maxMinutes` + 10 +
`maxAsks` × `approvalWaitMinutes`, so waiting for you never makes it fire first.

- **The message shows the first 10 detail lines,** an engine limit. They are the branch (for
  a worker), the path of `report.md` with a note that the report is the child's text, and
  then the report, whose first lines are its answer.
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
- **A role with `writes: false`** needs a `tools` list, because the child's usual tools
  include `bash`, `write` and `edit`, and is refused if the list names `bash`, `powershell`,
  `write`, `edit` or `notebook_edit`. `jig-core`'s contract has no way to ask which other
  tools write, so the child's own `jig-core` rules govern the rest: `scout` and `reviewer`
  list `git`, whose commit and branch actions are local writes the rules allow.
- **Where files are read,** lowest first: the plugin's `agents/`, `agents.folders`, then
  `~/.pi/agent/agents/`. A file with an earlier name replaces it. Project folders are
  never read. The tool's description lists the roles, and is registered again at session
  start when a company's or the user's files change the list.
- **When the agent delegates** is one rule in the tool description and in the skill: if an
  answer needs more than about five files or 20,000 tokens of output, start a scout; use
  `reviewer` for a fresh look at your own change. The earlier harness measured that its
  agent delegated only when asked, so `jig-workflow` can name `reviewer` in its review stage.
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
| `branch` | a branch name that holds `{name}` | `agent/{name}` |

- **Models are checked** against `enabledModels` in Pi's global `settings.json`. Project
  settings are never read, because the model can write there. A model outside the list
  refuses the `start` with the allowed patterns. Without the setting every model Pi knows
  is allowed, which is what Pi itself means by it. A model Pi does not know is refused too.
- **A role in the configuration with no agent file** is a warning in `/agents roles`.
- **Company defaults** arrive through `config.addSectionDefaults("agents", ...)`, and the
  user's own section is laid over them.
- **`maxAsks` of 0** means every ask is denied, the same as `approvals: "deny"`.

## Lifecycle

- **States:** starting, running, waiting for you (running, with a question open), then
  finished, stopped, failed or lost.
- **No orphans.** When the parent session shuts down, for any reason (`/new`, `/resume`,
  `/fork`, `/reload` or quit), every child's input is closed and its process group is
  signalled, with SIGKILL after 3 seconds. If the parent dies without that, its pipe
  closes, and Pi's RPC mode shuts down when its input ends. As a second line, at every
  session start the plugin reads the run folders' `meta.json` files and stops a child that
  is running while its parent is not; a process is touched only when its recorded start
  time still matches, and a child whose parent is another live Pi is left alone. A child
  also checks every 10 seconds that its parent still exists, asks Pi to shut down when it
  does not, and leaves by itself 5 seconds later, because Pi in RPC mode only notes that
  request and acts on it at the next command. A `/reload` therefore ends running children;
  `message` resumes them from their sessions.
- **Not in a session that will end.** In print or JSON mode `start` is refused, because
  a result would have nowhere to go.
- **One writer per folder, and a worktree for a writer.** A `writes: true` role works in a
  new worktree, made with `git worktree add -b <branch> <folder> HEAD` through `jig-core`'s
  `exec.git` (hooks off), in a folder named `<repository>-<name>` beside the repository.
  The branch comes from `agents.branch`; if it exists, the child's id is added. It is cut
  from the parent's HEAD, so uncommitted changes are not in it. A start that fails takes
  the worktree and its branch away again (`git` refuses if anything was done in it). The
  report names both.
- **Run folder:** `agents/<session>/<child>/` in `jig-core`'s state folder, with
  `meta.json`, `system-prompt.md` and `report.md`. Folders older than 14 days are
  removed when a session starts, unless the child is recorded as running. Pi's own session
  files are not touched.
- **Counts:** `maxRunning` children at once and `maxStarted` per session. A child has no
  `subagent` tool, and the plugin in a child refuses `start`, so nothing nests.

## Records and the lens

- **Each child's `jig-core` writes its own records** in its own session, with the role
  and parent session from the environment. The record of the parent's `subagent` call
  has the action, and never the task.
- **Each child's session file** is in Pi's usual sessions folder, so `pi -r` lists it and
  `/lens usage` counts its cost once.

## Tests

1. **Unit tests** for the arithmetic of limits, the RPC client (framing, ids, bad lines),
   the cleaning of text, the reading of requests, agent files, configuration, the command
   line and the environment.
2. **A parent session with a fake child.** `test/world.ts` runs a real Pi session (the
   SDK with its scripted model) with the real `jig-core` and the plugin, and
   `support/fake-child.mjs` stands in for Pi: a small Node program that speaks the protocol
   of Pi's docs from a script. Every line of "Every failure is a no" has a test, and so have
   the queue, each limit, steering, stopping, resuming, a worker's worktree, a child that
   is not what was asked for, a child that dies or floods, the end of the session, the
   sweep for orphans and the check in a child.
3. **The stock Pi as a child.** `test/real-pi.test.ts` starts the Pi installed next to this
   Node with this repository's `jig-core` and `jig-agents` loaded through `settings.json`,
   and gives it a scripted model by an extension (`support/scripted-model.ts`) that
   registers Pi's own faux provider. It runs in a temporary agent folder and home, with
   `AWS_PROFILE` and every other name the plugin drops left out. It proves, in order:
   - the flags and environment make a Pi that lists `jig-core`'s and `jig-agents`' commands,
     honours `--session-id` and `--model`, and ends cleanly when its input closes;
   - a child whose parent has gone shuts itself down;
   - a child's "ask" reaches a fake screen, a yes lets the tool run and a no stops it, the
     follow-up "Why decline?" is forwarded, and what you type reaches the child's model;
   - "Allow for this subagent" covers that child's later calls and no other child's;
   - no screen is a no; a turn limit stops a looping child and ends its process;
   - ending the parent's session ends a child that is waiting on a question;
   - a Pi started without `jig-core` is refused before it gets its task;
   - the child's call records name its role and its parent's session.

   It is skipped, with the reason, when no Pi 1.x is installed next to this Node
   (`JIG_AGENTS_TEST_PI` names another).

What these do not show is on the [Not verified](not-verified.md) page.

Back to the [jig-agents overview](../README.md).
