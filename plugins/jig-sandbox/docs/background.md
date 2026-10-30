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
| `bg_output` | A task's output: the lines not read yet, the last `tail` lines, or from an `offset`; optionally only the lines matching a `filter` |
| `bg_list` | Every task of this session: id, state, run time, name, command, ready and error matches |
| `bg_kill` | Stops a task, or `all`: a polite stop, three seconds, then a hard one |

## Waking the agent

- **Events:** the task ended; a `ready` pattern matched (once per task); an `error`
  pattern matched.
- **One message for a burst:** events that arrive within a second are sent as one
  message, so a build that prints three errors wakes the agent once.
- **Error floods:** at most three error wake-ups per task, 30 seconds apart. Matches in
  between are counted and reported in the next message.
- **One at a time:** a new message waits until the agent has received the previous
  one.
- **What it says:** the task, the event, the matching line, and the last 20 lines.

```text
Background task bg-3 "dev server": READY, matched /Listening on/ after 4.2s (still running).
Matched line: Listening on http://localhost:8080
Last 20 lines: ...
```

Patterns are checked before the task starts: at most five of each, 200 characters,
and no constructs that can make matching slow (back-references, look-behind, nested
repeats).

## Limits

| Setting | Default | Meaning |
|---|---|---|
| `background.maxTasks` | 4 | Tasks running at once |
| `background.maxRuntimeMinutes` | 240 | Longest run, and the default deadline |
| `background.keepFinished` | 12 | Finished tasks kept for `bg_list` and `bg_output` |
| `background.wake` | `on` | `off` sends the messages without waking the agent |

Logs rotate at 4 MiB per task, two segments kept, in a private folder of the session.

## Lifecycle

- **Each task is sandboxed** with the same rules as a foreground command, and its
  output is cleaned and redacted the same way before anyone reads it.
- **Tasks end with the session:** quitting, starting a new session or reloading stops
  them. A task left behind by a crash is found and stopped at the next session start.
- **Stopping** sends the stop to the task's whole process group, so a server's child
  processes stop with it.
- **Background tasks need an interactive session.** Without one, run the command in
  the foreground.

## `/ps` and the footer

`/ps` lists the tasks, shows a task's log as it grows, and stops one. When you stop a
task from `/ps`, the agent gets one line saying so, without being woken. The footer
shows how many tasks run, through `jig-theme`'s `jig-theme:segment` event.

## Reaching a task's server

- **In `open` mode** (the default), a task shares the machine's network: later
  commands and you reach its server at `localhost` and its port, as outside.
- **In `filtered` and `ask` modes,** each command has a network of its own, so
  `jig-sandbox` bridges each port a task listens on into every later command and to
  the host. See [Design](design.md#localhost-across-commands-in-filtered-and-ask).
