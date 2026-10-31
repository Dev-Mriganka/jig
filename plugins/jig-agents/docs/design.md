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
   has no dependency. The source is about 3,500 lines with its comments: the estimate of
   1,000 left out the checks, the cleaning of text, the orphan sweep and the roles' policy.
5. **A role only narrows, and the child enforces it.** What a role says about what its child
   may do is checked in the child, by a gate in its own `jig-core`, and it can only make
   the child's rules stricter ([below](#a-role-only-narrows-and-the-child-enforces-it)).

## One child, end to end

```text
agent calls subagent {action: "start", role: "scout", task: "..."}
  -> jig-core's rules (subagent start: a local write, allowed by default)
  -> jig-agents, in the parent
       check    role, cwd, counts, model (configuration, then enabledModels)
       plan     the role with configuration laid over it: its policy, the skills it sees, its prompt;
                refused here when it cannot run (bash with no sandbox, a skill it lacks)
       worktree for a writer
       launch   Pi's own program with --mode rpc; stdin and stdout are pipes; JIG_ROLE_POLICY in its environment
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
| `--model`, `--thinking` | From configuration, or the parent's own, after the check against `enabledModels`; the thinking level is [chosen below](#skills-which-a-child-sees) |
| `--tools <list>` | The role's list, which can only narrow |
| `--exclude-tools subagent,mcp__*` | No children of children; no MCP tools unless the role names one |
| `--no-skills`, `--skill <file>` | The child sees the skills its role gives it and no other ([Skills](#skills-which-a-child-sees)) |
| `--no-context-files` | Only for `context: none`: the child does not read AGENTS.md or CLAUDE.md |
| `--append-system-prompt <file>` | The role's prompt and the skills it preloads, from a file in the run folder |
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
- **What it may do.** It gets `JIG_ROLE_POLICY`, the role's limits as one JSON line. The
  parent's own value, if it has one, is never copied: the list of names above leaves it out, and only
  the policy built for this role is set.
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
its plugins, for example because of a broken settings file, which would run ungoverned, and a
child that cannot read its role's policy, which reports it the same way (below). A
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

An agent file is front matter and a prompt. Its fields, who may change each, and an annotated example are in the
[README](../README.md#roles-and-agent-files); this page has how they are read and what is done with them.

| Field | How it is read |
|---|---|
| `name` | Letters, digits, `-` and `_`; defaults to the file name |
| `description` | One line of at most 200 characters, which the parent agent reads in the tool's role list |
| `tools` | A comma-separated list of tool names; only a role that writes may leave it out |
| `actions`, `ask` | `tool action\|action, tool action`: a tool, then its actions. A tool is named once and must be in `tools` |
| `writes` | `true` or `false`; default `false` |
| `skills` | `none`, or a list of skill names (lowercase letters, digits and hyphens) |
| `preload` | A list of skill names, each of which must be seen |
| `context` | `project` or `none` |
| `thinking` | One of Pi's levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

- **Unknown fields are errors,** and so is a `model`, `limits` or `extensions` field: those belong
  to configuration or are not allowed at all. The message lists the fields there are.
- **A role with `writes: false`** needs a `tools` list, because the child's usual tools include `bash`, `write` and
  `edit`. It is refused if the list names `powershell`, `write`, `edit` or `notebook_edit`. It may list `bash`, which the
  launcher allows only where the child has a sandbox ([Read-only bash](#read-only-bash)).
- **Other tools are judged call by call.** `jig-core`'s contract has no way to ask which tools write, so the child's own
  `jig-core` classifies each call, and the gate below refuses the writes among them.
- **`ask` cannot name an action that `actions` does not allow,** and `preload` cannot name a skill that
  `skills` leaves out: each would never be reached.
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

## A role only narrows, and the child enforces it

The rule is Codex's: a role may customise its child or reduce what it can do, never replace the parent's
authority ([compared](options.md#specialisation-compared-2026-11-01)).

Before this, a role narrowed only by tool name, and `writes: false` only checked the tool list, so the shipped scout
and reviewer had the whole `git` tool, push included. Now what a role says about what its child may do is enforced in the child.

```text
agent file ──┐
             ├─ policy.ts: the effective role ─ role-plan.ts ─ launch.ts ── JIG_ROLE_POLICY ──┐
configuration┘   (writes, actions, ask)         (skills, prompt, checks)                        │
                                                                                                ▼
  in the child: jig-agents reads the variable at start ── role-gate.ts: a jig-core gate ── every tool call
                jig-sandbox reads it too ── locks the home and working folders when the role does not write
```

### The policy variable

`JIG_ROLE_POLICY` is JSON on one line: `{"v":1,"role":"scout","writes":false,"actions":{"git":["status","log"]},"ask":{}}`.
`jig-core`'s kit writes and reads it (`kit/role-policy.ts`), so `jig-agents` and `jig-sandbox` cannot read it two ways.
A value that is set and cannot be read is `unreadable`, never `absent`.

**Why an environment variable is safe, and what is assumed.** A process's environment is fixed when it starts. The
model can run commands, and a command changes only the environment of its own child process; it cannot give the Pi
that runs it another variable. What is assumed:
- **Only trusted code runs inside the Pi process.** Extensions can change `process.env`, and they are the user's own
  packages, loaded from places the model cannot write.
- **The sandbox keeps a command away from the child's process.** A test shows that a command cannot read the Pi process's
  environment through `/proc`. Writing its memory or attaching with `ptrace` would be needed to change it, and what has
  not been proved of `ptrace_scope` is on the [Not verified](not-verified.md) page.
- **The gate was registered before any call.** It is registered when the plugin loads, before a session starts.

### The gate

The plugin reads the variable once, when it loads in a child, and registers a `jig-core` gate named `role-policy`
([Gates](../../jig-core/docs/plugin-contract.md#gates)). The gate sees every call after the rules have decided, and can only
make the decision stricter:

| The policy says | The gate does |
|---|---|
| `writes: false` | Refuses every write, except a plain `bash` while the sandbox is active |
| `actions` names a tool | Refuses any other action of that tool, and a call with no action |
| `ask` names a tool action | Turns an allow into an ask, naming the role in the question |
| none of these | Says nothing, and the child's usual rules decide |

- **An empty list of actions refuses the tool whole,** and "allow for this session" does not stop an `ask` asking again.
- **The words name the role,** such as `the role "scout" may not write, and git commit writes`. The record of a refused call
  has the decision source `gate` and says `held by gate role-policy`; `jig-core` never records a gate's reason, but every
  record of a child carries its role (`JIG_AGENT_ROLE`).
- **A policy that cannot be read refuses everything.** The gate then denies every call, and the plugin throws when the
  session starts. Pi reports that as an `extension_error`, which is the path the start-up check already has for a plugin
  that failed to load: `start` fails with `a plugin failed to load in the child: ... JIG_ROLE_POLICY cannot be read`.
- **Only `JIG_ROLE_POLICY` is looked for.** A session with `JIG_AGENT_ROLE` and no policy is not refused, because a user
  may set that name to label records.
- **Tool names are looked up as own properties,** so a tool called `constructor` is not found in a list by accident.
- **The parent checks action names** against the tool's own `action` parameter when it can, and refuses a start for an
  action the tool does not have: a misspelt `statuss` would otherwise refuse everything, and a misspelt `ask` would ask about nothing.

### Read-only bash

`jig-core` classifies `bash` as a write whatever the command is, because a shell string can do anything. So a read-only role
could not have it, and a scout could not run `rg` or `git log`. Now it can, where the child has `jig-sandbox`:

1. **The launcher checks.** A role with `writes: false` and `bash` is refused at `start`, before a worktree or a process
   exists, when the parent has no `/sandbox` command. `/agents roles` shows the same warning. The child must then list
   `/sandbox` too, which the start-up check already requires when the parent has it.
2. **The sandbox locks.** `jig-sandbox` reads the policy and, for a role that does not write, adds two locked rules, for the
   home folder and the working folder ([its design](../../jig-sandbox/docs/design.md#a-child-agent-that-may-not-write)). A
   command reads them and writes neither. `/tmp` and the session's scratch folder stay writable.
   - **The caches are locked with the home folder:** the runtime lays a read-only mount over a folder after the writable ones.
   - **That is a loss and a gain.** A role that wants to build cannot, and a changed file in a cache, which is how a writing
     agent could affect a later build outside the sandbox, cannot be made.
3. **The gate checks at each call** that the sandbox is registered, on and able to run commands (`sandbox.canRun`), and
   refuses `bash` otherwise. `bash` with `outside: true` is the action `outside`, which is a write, so a read-only role
   cannot run a command outside the sandbox.

`write`, `edit`, `powershell` and `notebook_edit` stay forbidden in a read-only role: they have no sandbox around them.

### Skills: which a child sees

Pi advertises every skill to the model, and its own documentation says a model may fail to load a relevant one. The parent
works out the list and starts the child with `--no-skills` and one `--skill <file>` for each skill the child keeps.

- **Where the list comes from.** Pi gives an extension no call for its skills, only `pi.getCommands()`, which lists each as
  `skill:<name>` with the path of its file. A skill's folder and its `metadata` are read from that file.
- **By default they follow the tools.** A skill belongs to a plugin when its file is in `plugins/<plugin>/skills/`, as Jig's are, or
  when its front matter says `metadata: jig-tool: <tool>` (one tool, or several separated by commas). The front matter wins.
- **A skill is seen** when the role has a tool that its plugin declared to `jig-core` (`jig().tools.declared()`) or that it names.
  A skill with no owner, or whose plugin declared no tool, is always seen, and so is every skill for a role with no `tools` list.
- **Why `metadata`.** The Agent Skills format defines it for keys of the author's own, and Pi's parser ignores the keys it does not
  read (a test loads a skill with the field through Pi's own loader). The alternatives were a side file, or the company's `agents`
  configuration; the field keeps the claim next to the skill that makes it.
- **`skills: a, b`** is exactly those, in that order, whatever the tools are. A name the session does not have refuses the start and lists
  the ones it has. `skills: none` is `--no-skills` alone.
- **`preload`** reads each skill's file, drops its front matter, and appends it to the role's prompt under `## Skill: <name>`, with the
  folder its relative paths are for. A skill longer than 64 KiB is refused. It must also be seen.
- **`context: none`** is `--no-context-files`, so the child does not read AGENTS.md or CLAUDE.md.
- **`thinking`** is `--thinking`. From strongest: `agents.roles.<role>.thinking`, the `:level` on the configured model, the file's
  `thinking`, and for a child that runs the parent's model, the parent's own level.

### Configuration laid over a file

| Value | How configuration combines with the file's |
|---|---|
| `writes`, `tools` | Not settable: the section that tries is refused, and the message says they are the file's |
| `actions` | A tool in both keeps the actions both list; a tool only configuration names is narrowed to its list |
| `ask` | The file's and configuration's together. A company's and yours add up as well |
| `skills`, `preload`, `context`, `thinking` | Configuration's replaces the file's: they give a child less to read, and are not authority |

A company's defaults and the user's section are laid over each other by `jig-core` first (a list of yours replaces a
company's, except `ask`, which adds up), and the plugin then lays the result over the file. A resumed child gets the policy of
the role as it is then.

### Attacks on a role

| Attack | Why it does not work |
|---|---|
| The child's model edits its own environment | A command changes only its own child process. Extensions that could are the user's own code |
| The child unregisters or replaces the gate | Only plugin code can; a gate registered again by name replaces it, and no tool does that |
| A project's agent file widens a role | Project folders are never read, and the user's own folder is one the model cannot write |
| Configuration widens a role | `writes` and `tools` are not settings, `actions` only narrows, and `ask` only adds |
| A read-only role runs a command outside the sandbox | `bash` with `outside: true` is its own action, a write, which the gate refuses |
| A read-only role uses `bash` with the sandbox off or broken | The gate asks `sandbox.canRun` at each call; the sandbox refuses when it cannot start |
| A read-only role writes a cache that a later build uses | The home folder is locked, the caches included |
| A policy is damaged on the way | An unreadable policy refuses every call, and the start fails |
| A skill claims a tool to be seen | It can only make itself seen by a role that has the tool; a role's `skills` list still decides |

## Configuration

| Field | Type and range | Default |
|---|---|---|
| `roles.<role>.model` | `provider/id` or `provider/id:thinking`, in `enabledModels` | the parent's model |
| `roles.<role>.maxTurns` / `maxMinutes` / `maxCost` | the ranges above | `limits` |
| `roles.<role>.approvals` | `forward` or `deny` | `approvals` |
| `roles.<role>.actions` | `{ "tool": ["action", ...] }`, at most 40 tools and 60 actions each; an empty list refuses the tool | the file's |
| `roles.<role>.ask` | `{ "tool": ["action", ...] }`, each list of at least one action | the file's |
| `roles.<role>.skills` | `"none"`, or 1 to 30 skill names | the file's, else the tools' |
| `roles.<role>.preload` | 1 to 10 skill names, each also seen | the file's |
| `roles.<role>.context` | `"project"` or `"none"` | the file's, else `project` |
| `roles.<role>.thinking` | one of Pi's levels | the model's `:level`, else the file's |
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
  user's own section is laid over them. The section is registered with `union: ["roles.*.ask.*"]`, so a company's
  `ask` and yours add up and neither replaces the other.
- **`writes`, `tools`, `description`, `prompt` and `name` under a role** are refused with a message that says they are the
  agent file's. Any other unknown field is an `unknown field`, as before.
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
   the cleaning of text, the reading of requests, agent files (every field and every mistake),
   configuration, the command line and the environment. The role's own parts have theirs:
   `policy.test.ts` (configuration narrows and never widens), `skills.test.ts` (which skills follow
   which tools, the `metadata` field, preloading) and `role-gate.test.ts` (the verdicts as data).
2. **A parent session with a fake child.** `test/world.ts` runs a real Pi session (the
   SDK with its scripted model) with the real `jig-core` and the plugin, and
   `support/fake-child.mjs` stands in for Pi: a small Node program that speaks the protocol
   of Pi's docs from a script. Every line of "Every failure is a no" has a test, and so have
   the queue, each limit, steering, stopping, resuming, a worker's worktree, a child that
   is not what was asked for, a child that dies or floods, the end of the session, the
   sweep for orphans and the check in a child. `role-start.test.ts` starts the fake child from
   each kind of role and reads its command line and environment: the policy, the skills, the
   preloaded text, `--no-context-files`, the thinking level, configuration laid over the file, and the
   refusals before anything starts. `role-gate.test.ts` also runs a session whose environment holds
   a policy, which is what a child is, and calls tools through the real `jig-core`.
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
   - the child's call records name its role and its parent's session;
   - a role that may not write is refused a write by the child's own gate, which names the role, and a read runs;
   - `actions` lets only the listed actions of a tool run, and `ask` asks about an action the rules allow;
   - a policy the child cannot read fails the start the way a plugin that failed to load does;
   - `bash` in a read-only role is refused by a child that has no sandbox, and runs for a role that writes;
   - in a real child that loads `jig-sandbox` too, a read-only `bash` reads, writes `/tmp` and cannot write its working
     folder, and `bash` with `outside: true` is refused before anyone is asked (skipped, with the reason, without
     bubblewrap and its friends);
   - the child's model is given only the skills its role names or its tools bring, the whole text of a preloaded one,
     and no AGENTS.md for `context: none`, which the scripted model reports from the prompt it was given.

   It is skipped, with the reason, when no Pi 1.x is installed next to this Node
   (`JIG_AGENTS_TEST_PI` names another).

What these do not show is on the [Not verified](not-verified.md) page.

Back to the [jig-agents overview](../README.md).
