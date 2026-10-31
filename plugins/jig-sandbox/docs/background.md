# Background tasks

A dev server, a file watcher or a long build should not hold the agent's turn, and the
agent should not sleep and poll to wait for it. Background tasks start, run in the
sandbox, and wake the agent when something happens. Back to the [jig-sandbox overview](../README.md).

## The tools

**`bash`, with three more fields**

| Field | Meaning |
|---|---|
| `background` | Start the command as a task and return its id at once |
| `name` | A label for lists and messages, up to 40 characters. Default: the command's start |
| `notifyOn` | `{ "ready": [...], "error": [...] }`: patterns the command prints when it is up, or when it failed. Each wakes the agent |

`timeout` is the task's longest run, up to `maxRuntimeMinutes`. Every task has a
deadline.

```text
Started background task bg-3 "dev server" (sandboxed, at most 4h).
Wakes you on: exit; ready /Listening on/; error /ERROR|Exception/.
Read its output with bg_output {"id":"bg-3","tail":40}. Do not sleep or poll.
```

| Tool | What it does |
|---|---|
| `bg_output` | A task's output: the lines not read yet, the last `tail` lines, or from an `offset`; optionally only the lines that contain a `filter` text, ignoring case |
| `bg_list` | Every task of this session: id, state, run time, name, command, ready and error matches |
| `bg_kill` | Stops a task, or `all`: a polite stop, three seconds, then a hard one |

All three act on this machine only. `bg_output` and `bg_list` are reads for
[`jig-core`](../../jig-core/README.md), and `bg_kill` is a local write, which is allowed
without asking. A `bash` call with `background` is the same local write `bash` is.

## Waking the agent

- **Events:** the task ended; a `ready` pattern matched (once per task); an `error`
  pattern matched.
- **One message for a burst:** events that arrive within a second are sent as one
  message, so a build that prints three errors wakes the agent once.
- **Error floods:** at most three error wake-ups per task, 30 seconds apart. Matches in
  between are counted and reported in the next message.
- **One at a time:** a new message waits until the agent has received the previous
  one.
- **No repeats:** a wake-up whose matching line the agent has already read with
  `bg_output` is dropped, and a task the agent stops itself wakes it with nothing.
- **What it says:** the task, the event, the matching line, and the last 20 lines.

```text
Background task bg-3 "dev server": READY, matched /Listening on/ after 4.2s (still running).
Matched line: Listening on http://localhost:8080
Last output:
...
```

## Patterns

A pattern is a JavaScript regular expression, written without slashes and matched
against one line at a time, case-sensitively. Only the first 4 KiB of a line is matched.
A carriage return ends a line too, so a progress meter and a prompt count.

Patterns are checked before the task starts, and a task with a refused pattern does not
start:
- at most five of each kind, 200 characters each;
- **no constructs that can make matching slow:** a back-reference (`\1`), a look-behind
  (`(?<=`), a repeat inside a repeat (`(a+)+`), or a count above 1,000;
- **no pattern that matches an empty line,** since it would match every line.

## Limits

| Setting | Default | Meaning |
|---|---|---|
| `background.maxTasks` | 4 | Tasks running at once |
| `background.maxRuntimeMinutes` | 240 | Longest run, and the default deadline |
| `background.keepFinished` | 12 | Finished tasks kept for `bg_list` and `bg_output` |
| `background.wake` | `on` | `off` sends the messages without waking the agent |

Logs rotate at 4 MiB per task, with two segments kept, in a folder of the session under
`<agent folder>/jig-sandbox/background`. That folder is locked, so a command cannot swap
a log for a link to a file Pi can read and the command cannot. Offsets count from the
first byte the task wrote and stay valid after rotation drops the oldest.

## Lifecycle

- **Each task is sandboxed** with the same rules as a foreground command. Its output is
  cleaned of terminal control sequences and has credential values taken out before it is
  written, so nothing that reads the log sees either.
- **After it ends,** the sandbox does what it does after any command: the audit undoes
  what the task planted, and the lines that explain a refusal travel with the message that
  says it ended.
- **A task cannot run outside the sandbox.** `outside: true` with `background` is refused
  and nobody is asked, since a task outlives the call a person could watch. With the
  sandbox switched off, a task is refused too.
- **Tasks end with the session:** quitting, starting a new session or reloading stops
  them. A task left behind by a crash is found by the next session start and stopped.
- **Stopping** sends the stop to the task's whole process group, so a server's child
  processes stop with it. The inner groups under bubblewrap get the polite signal first,
  so the task's own trap can close a server, and a task that ignores it is killed.
- **Background tasks need an interactive session.** Without one, run the command in the
  foreground.

## `/ps` and the footer

`/ps` lists the tasks, shows a task's log as it grows, and stops one.

| Command | What it does |
|---|---|
| `/ps` | A menu of the tasks: pick one to view its output or stop it, or forget the finished ones |
| `/ps list` | The tasks, one line each |
| `/ps view <id>` | The end of a task's output |
| `/ps kill <id\|all>` | Asks first, then stops it |

When you stop a task from `/ps`, the agent gets one line saying so, without being woken.
The footer shows how many tasks run, through `jig-theme`'s `jig-theme:segment` event.

## Reaching a task's server

- **In `open` mode** (the default), a task shares the machine's network: later
  commands and you reach its server at `localhost` and its port, as outside.
- **In `filtered` and `ask` modes,** each command has a network of its own, so
  `jig-sandbox` bridges each port a task listens on into every later command and to
  the host. See [Design](design.md#localhost-across-commands-in-filtered-and-ask).

## Credit

The idea (a `background` flag on `bash` and three tools to read, list and stop tasks),
the paging helpers, the layout of the log and the order of the group stop are adapted from
[gvanderclay/pi-bg-bash](https://github.com/gvanderclay/pi-bg-bash) (MIT, Copyright (c)
2026 Gage Vander Clay; the notice is in [LICENSE-pi-bg-bash](LICENSE-pi-bg-bash)). Waking
on a pattern, limiting repeats and holding a message while one is on its way are
behaviours described in aliou/pi-processes's README; no code was taken from it.
