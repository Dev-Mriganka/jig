# Watches

How `jig-core`'s watch engine works, and the `watch` tool that lists and stops
the watches of every plugin. Back to the [jig-core overview](../README.md).

A plugin registers a kind of watch and starts watches from its own tools. The
engine polls them, saves them, and tells the agent when one ends.

## The `watch` tool

The actions are in the overview. Their details:

- **One line per watch:** id, title, status, age, and the outcome when there is
  one, such as `k3m9x2ab | checks of pull request 42 | open | 12 min`. The age
  is the time since the watch started.
- **A watch whose plugin is not loaded** shows `waiting for its plugin
  (jig-git)` in place of its status.
- **The structured result** also carries, for each watch, the one line its
  kind gives for what it watches (`describe`).
- **`stop` sends no message to the agent,** because the agent or you asked for
  it. Other plugins still hear of it (see [Events](#events)).
- **`/jig` shows how many watches are open.**

## What a plugin does

- **Registers a kind,** once when it loads, with `watches.registerKind({ kind,
  plugin, intervalMs, describe, poll })`. Kinds are unique by name. Registering
  one again replaces it, because Pi loads plugins again on a reload.
- **Starts a watch** from one of its tools with `watches.start({ kind, spec,
  title, timeoutMinutes, stallMinutes })`. The call returns the watch's id at
  once. A kind that is not registered is an error, and so is a start while no
  session is running. The title is one line of at most 200 characters.
- **`poll(spec, state, signal)`** returns `{ state, done, nextPollMs }`. `done`
  is the finish line: `{ outcome, summary, details, links, facts }`. `state`
  comes back with the next poll, and after a restart.
- **`spec` and `state` are plain JSON,** saved as plain text. Put a reference to
  a secret in them, never the secret.

## How a watch runs

- **The first poll** comes about 2 seconds after the watch starts.
- **Each poll has 60 seconds.** Its signal is cancelled then, and the poll
  counts as failed.
- **The next poll** comes after `nextPollMs`, or else the kind's `intervalMs`,
  kept between 5 seconds and 10 minutes. The state is saved after every poll.
- **When `done` arrives,** the watch ends with that result.
- **The deadline** is `timeoutMinutes` after the start (default 60). A last poll
  is made at that moment, and a poll that ends after it counts as the last. If
  the watch is still not done, it ends as `timed-out`.
- **A stall notice** is shown to you once, with `ctx.ui.notify`, when the watch
  is still going after `stallMinutes` (default 30). It does not wake the agent.
  A session without a screen shows nothing, and the notice stays owed.
- **A poll that throws is a failed poll.** An answer that is not a result of the
  right shape is one too. Three in a row pause the watch, with one notice to you
  and one message to the agent. A poll that works starts the count again.
- **A paused watch** is picked up again, with a fresh count, when the session
  next starts.

## What the agent is told

- **One message per result,** sent with `deliverAs: "followUp"` and `triggerTurn:
  true`: an idle agent starts a turn, and a busy one reads it when its turn ends.
  The message has the type `jig-watch` and is shown on screen.
- **In plain words:** the title, the outcome, the summary, the first 10 lines of
  the details and the first 5 links. The rest stays in the saved result. For
  example:

  ```text
  The watch "checks of pull request 42" failed.
  2 of 12 checks failed: build, lint
  Details:
    build: error TS2304
  Links:
    https://ci.example/runs/9
  ```
- **Messages are combined and spaced.** Results that end within 1 second of the
  first go in one message. Messages are at least 10 seconds apart. Only one
  waits at a time, and later results join it.
- **A pause is told the same way,** with the last error and the watch's id, so
  the agent does not wait for a result that is not coming.
- **After a restart,** a result found by the first poll begins with `While Pi was
  closed: `.
- **Nothing is sent when a watch is stopped.**

## What is cleaned

A message does not pass the hook that cleans tool results, so the engine cleans
the text itself, when the watch ends:
1. Terminal escape codes and control characters are removed.
2. Secrets are redacted.
3. Personal data is masked, as for a production result.
4. The summary is cut to one line of 500 characters. The details are cut to 40
   lines of 1 000 characters; the 40th line says how many lines were cut.

Links are redacted but not masked, so they stay links, and at most 10 are kept.
Facts are cleaned like the facts in a record. If masking fails, the summary is
replaced by a note, the details are dropped, and the outcome stays. The title is
redacted whenever it is shown. The same cleaned result goes into the saved file
and the event.

## Saved watches

- **A file per watch** in `<state folder>/watches/<id>.json` (file 0600, folder
  0700). It holds the id, kind, plugin, title, spec, state, status, start time,
  deadline, stall time, session id and failure count. A finished watch keeps its
  result. The id is 8 characters of a lowercase alphabet without `i`, `l`, `o`
  and `u`.
- **At session start,** the watches that are open or paused and belong to this
  session are loaded, and those whose kind is registered are polled again after
  2 seconds. A resumed session has the same id, so it gets its watches back.
  Another session's watches are left as they are.
- **A watch whose kind is not registered** stays saved and shows as waiting for
  its plugin. It starts polling when the plugin registers the kind.
- **A deadline that passed while Pi was closed** makes the first poll the last.
- **Finished watches** are deleted 7 days after they ended, when a session
  starts. Open and paused ones are never deleted.
- **A file that cannot be read** is skipped and counted. A watch that cannot be
  saved goes on in memory. `/jig` shows both problems.
- **At shutdown** every timer is cleared and every poll in flight is cancelled.
  The timers never keep Pi alive, so print mode can exit.

## Events

`jig:watch-done` on Pi's event bus, when a watch ends for any reason, a stop
included: `{ id, kind, plugin, title, result }`. The result is the cleaned one.
A pause is not an end, so it has no event.

## Where the code is

`src/watch/`: `engine.ts` polls and decides, `store.ts` saves, `outbox.ts`
spaces the messages, `message.ts` and `clean.ts` write and clean the text,
`tool.ts` is the `watch` tool, and `format.ts` and `timers.ts` help.
