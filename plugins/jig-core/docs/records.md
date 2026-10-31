# Records

What `jig-core` writes down about every tool call and model turn, for
`jig-lens` to read. Back to the [jig-core overview](../README.md).

One JSON line per event, in `<state folder>/records/<YYYY-MM-DD>.jsonl`, where
the day is UTC. The file is private to you, and only `jig-core` writes it.
Every line has its own `id`, so a reader that imports a line twice still counts
it once.

- **Tool call:** time, session, parent session and agent role (for a child
  agent), ticket when one is active, tool, action, plugin, environment,
  effect, decision, approval kind, your answer, time waited for you, outcome,
  error kind, duration, tool call id, parent call id, spill path, and the
  tool's facts.
- **Model turn:** time, session, parent session, agent role, ticket, model,
  input, output, cache-read and cache-write tokens, and cost. These come from
  Pi's usage data.

**Facts** are a few named numbers or short codes that a Jig tool adds to its
own record, as declared in its contract: for example, tests passed and failed,
or a CI run's conclusion. They are never free text. The limits:
- a string over 64 characters is dropped, and so is anything that is not a
  number, a flag or a string;
- a fact whose name is over 64 characters is dropped too;
- a record keeps at most 50 facts;
- string facts are redacted.

A record never contains tool arguments or tool output. An error is kept as its
kind plus one masked and redacted line of at most 200 characters.

## Fields

| Field | Lines | Meaning |
|---|---|---|
| `id`, `kind`, `time` | all | A unique id, `call` or `turn`, and the time in ISO 8601, UTC |
| `session`, `parentSession`, `agentRole`, `ticket` | all | The Pi session id; the parent session; the agent role; the ticket |
| `tool`, `action`, `plugin` | call | What was called. `plugin` is the one that declared the tool, else where Pi says the tool came from |
| `environment`, `environmentKind`, `effect` | call | Where it acted (the tool's own name for it and the kind behind it), and `read` or `write` |
| `decision`, `decisionSource` | call | `allow`, `ask` or `deny`, and its source (see below) |
| `approval`, `answer`, `waitedMs` | call | The kind of question, your answer, and the milliseconds the call waited |
| `outcome`, `errorKind`, `error` | call | `ok`, `error` or `blocked`; the kind of failure; one line |
| `durationMs`, `toolCallId`, `parentToolCallId`, `spill`, `facts` | call | How long the tool ran; Pi's call ids; the spill file; the tool's facts |
| `model`, `input`, `output`, `cacheRead`, `cacheWrite`, `cost` | turn | The model id, the token counts, and the total cost in dollars |

A field that does not apply is left out. A call that never reached jig-core (an
unknown tool name, arguments that failed Pi's own checks) was never classified:
it has no environment, effect or decision, and its error kind is `not-run`.

- **`session`, `parentSession`, `agentRole`:** the parent session is
  `$JIG_PARENT_SESSION` when set, and the role is `$JIG_AGENT_ROLE` (default
  `main`). The ticket is the one set with `setTicket`.
- **`decisionSource`** is `table`, `rule`, `tool`, `session`, `unknown`,
  `floor` or `gate` (a plugin's gate asked or denied; the record says only
  that a gate held the call).
- **`approval`** is `dialog`, `review` or `form`; **`answer`** is `allow`,
  `allow-session` or `decline`; **`waitedMs`** includes the time in the queue.
- **`parentToolCallId`:** a nested call's id is `<parent>/<n>`.

### Error kinds

- **`denied`, `no-screen`:** a deny.
- **`declined`, `dismissed`:** the answer to a question.
- **`invalid`:** the tool's preview found the input invalid, so nobody was
  asked.
- **`internal`:** jig-core could not decide, so it blocked.
- **`tool`:** the tool ran and failed.
- **`withheld`:** the tool ran but its result could not be masked or redacted.
- **`not-run`:** the call never reached jig-core.

Records are kept for `records.retentionDays` and cleaned when a session starts.
If a line cannot be written, the call goes on, and `/jig` says so.
`/jig records` counts today's file, but not one over 200 MiB.
