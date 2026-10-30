# jig-core: the tool manager

**Status: built.** This README is the specification the code follows. What is
not built yet is in [Not built yet](#not-built-yet).

`jig-core` governs every tool call the agent makes, whoever wrote the tool:
- Pi's own tools;
- Jig's tools;
- tools from other packages.

For each call it works out where the call acts and whether it reads or writes,
applies your rules, asks you when a rule says so, masks and redacts the
result, and records the call. Every other Jig plugin needs it.

How it works: [Architecture](../../docs/architecture.md). The rules and the
floor: [Permissions](../../docs/permissions.md).

## What it does

| Part | Job |
|---|---|
| Classify | Gives each call an environment and an effect. Sources, in order: the tool's own declaration, a rule in your configuration, Pi's built-in defaults, the tool's hints, the default |
| Rules | Turns environment × effect, plus your rules, into allow, ask or deny, bounded by the floor |
| Approvals | Asks you inside the waiting call: dialog, review screen or form ([Approvals](../../docs/approvals.md)) |
| Secrets | Resolves secret references for Jig's tools through configured backends ([Secrets](../../docs/secrets.md)) |
| Mask | Replaces customer personal data in production results with tokens. Jig's tools mask their own results; this step is the backstop for every other tool |
| Redact | Removes every resolved secret value from output |
| Cap | Cuts output over 50 000 characters to its first 8 000, and saves the full text to a spill file |
| Record | Writes one line per tool call and per model turn, for `jig-lens` |
| Sign-in | Holds the sign-in services that company plugins register, and removes the headers they return from output ([Sign-in services](#sign-in-services)) |
| Watch | Runs background watches for every plugin: polling, finish lines, saving and resuming, and one message per result ([Watches](#watches)) |

## What other plugins get from it

The contract for a Jig tool is:
- how the tool declares the environment and effect of each action;
- how it asks for a secret, or for the sign-in a company provides;
- how it gives a preview for the review screen;
- how it adds facts to its record.

The contract for every plugin is:
- the watch engine: what to poll, how often, and when the watch is done;
- the record format;
- its own section of `jig.json`: the plugin registers the section and a check,
  and reads the section back (see [Configure](#configure));
- the events published on Pi's event bus, so other plugins can react to
  calls, decisions and results.

Plugins import only this contract, never each other.

## Tool: `watch`

Plugins start watches from their own tools, such as `jig-git`'s `checks watch`.
This tool lists and stops the watches of every plugin.

| Action | Parameter | What it does | Default |
|---|---|---|---|
| `list` | none | This session's open and paused watches, and the ones that finished in the last 24 hours, oldest first | local read |
| `stop` | `id` | Cancels an open or paused watch. It ends as `stopped` | local write |

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

## Watches

The engine behind the tool. A plugin registers a kind of watch and starts
watches from its own tools. The engine polls them, saves them, and tells the
agent when one ends.

### What a plugin does

- **Registers a kind,** once when it loads, with `watches.registerKind({ kind,
  plugin, intervalMs, describe, poll })`. Kinds are unique by name. Registering
  one again replaces it, because Pi loads plugins again on a reload.
- **Starts a watch** from one of its tools with `watches.start({ kind, spec,
  title, timeoutMinutes, stallMinutes })`. The call returns the watch's id at
  once. A kind that is not registered is an error.
- **`poll(spec, state, signal)`** returns `{ state, done, nextPollMs }`. `done`
  is the finish line: `{ outcome, summary, details, links, facts }`. `state`
  comes back with the next poll, and after a restart.
- **`spec` and `state` are plain JSON,** saved as plain text. Put a reference to
  a secret in them, never the secret.

### How a watch runs

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

### What the agent is told

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

### What is cleaned

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

### Saved watches

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

### Events

`jig:watch-done` on Pi's event bus, when a watch ends for any reason, a stop
included: `{ id, kind, plugin, title, result }`. The result is the cleaned one.
A pause is not an end, so it has no event.

## What it borrows

`jig-core` is its own code; it does not run on top of another permission
package. It borrows these patterns from `@gotgenes/pi-permission-system`:
- **`bash` split with tree-sitter,** so each command in a chain or a
  substitution is judged on its own, and anything that cannot be parsed asks;
- **the ask flow:** an inline dialog, a select-and-input fallback for RPC
  hosts, a timeout, and deny when there is no screen;
- **hiding a tool the rules deny completely,** so the model does not try it;
- **decision events** on Pi's event bus.

It is not a dependency, for three reasons:
- environments are that package's stated non-goal;
- it judges another package's tool by name only, while Jig decides per action
  and per argument;
- it has moved through about 30 major versions since June 2026.

See [Reuse](../../docs/reuse.md).

## Prerequisites

- Pi 1.4 or later.
- At least one secret backend, if a Jig tool needs secrets: `pass` on Linux
  first.
- On Linux, a sandbox for `bash`. While Jig is tried beside the existing
  harness, it borrows that harness's.

## Configure

`jig.json` in Pi's agent folder, which is `~/.pi/agent/jig.json` unless
`PI_CODING_AGENT_DIR` points elsewhere. A separate Pi profile has its own file.
All fields are optional. Company plugins add environments, classification rules
and masking field names at start-up, and register sign-in services.

| Field | Default | Meaning |
|---|---|---|
| `environments` | `local`, `external`, `production` built in | Add environments with a `kind`: `test` or `production`. A test environment can be set to `mask: true`; production masking cannot be turned off. The built-in names cannot be redefined, and an environment a company plugin made production cannot be lowered |
| `rules` | the default table in [Permissions](../../docs/permissions.md) | A list of rules, most specific first. Each one names a `tool`, optionally an `action`, `environment` or `effect`, and gives a `decision` (`allow`, `ask`, `deny`) and optionally an `approval` kind (`dialog`, `review`, `form`). Rules that would lower the floor are refused at load, with the file and the key named |
| `classify` | none | How to classify tools Jig did not write: `tool`, optionally `action`, a `param` and `value` (or `pattern`), and the resulting `environment` and `effect` |
| `secrets.backends` | `["pass"]` | Which backends may resolve references: `pass`, `env`, `keychain`, `op` |
| `records.retentionDays` | 90 | How long record files are kept |
| `spill.retentionDays` | 7 | How long spill files and rendered previews are kept |

An unknown field is an error. It names the file and the key, and the plugin
starts with the defaults rather than guessing. So is a wrong type or value.

### Rules

- **The first rule that matches decides.** List them most specific first. Your
  own rules come before the ones a company plugin adds, so yours win.
- **`tool` may use `*`** for any run of characters, as in `mcp__db__*`.
  `action`, `environment` and `effect` match exactly. A field you leave out
  matches anything.
- **A rule that would lower the floor is refused,** with the file and the key
  named, and the rest of the file still loads. That means a rule that names a
  production environment and allows or asks for a write there. A rule with no
  `effect` counts as covering writes, so give a production rule `effect:
  "read"`. An environment name nobody defined counts as production.
- **A wildcard rule cannot allow a tool that nothing classified.** Name the
  tool exactly, or classify it.
- **"Allow for this session" is remembered for a tool, an action and an
  environment.** Approving a deploy to one test environment does not approve a
  deploy to another.

### Classification rules

- **`param` is a top-level parameter of the call.** Strings, numbers and
  booleans are compared as text. `value` must match exactly; `pattern` is a
  regular expression.
- **`action`, if given,** must equal the call's own `action` parameter, and
  becomes the action of the result.
- **The first matching rule wins,** yours before a company plugin's. A rule
  beats Pi's built-in defaults, so a rule on `bash` can reclassify a command.

### Secret references

| Reference | Backend | What it reads |
|---|---|---|
| `pass:<entry>` | [pass](https://www.passwordstore.org/) | The first line of the entry. Entry names use letters, digits and `. _ @ + - /` |
| `env:<NAME>` | the environment of the Pi process | The variable's value |
| `keychain:<service>/<account>` | the macOS Keychain | `security find-generic-password -s <service> -a <account> -w`. The service is the part before the first `/` |
| `op://<vault>/<item>/<field>` | the 1Password command-line tool | `op read`, with an optional section before the field |

A reference whose backend is not in `secrets.backends` is an error that says
so. Every backend has a timeout. An error never repeats the reference or a
value.

### Sections of other plugins

The file is shared. Each Jig plugin keeps its settings in a section of its own,
such as `git` or `lens`.
- **A plugin registers its section** with `config.registerSection(name,
  validate)`, from `withJig()` in its factory, and reads it back with
  `config.section(name)`. `validate` returns error messages that name the key.
- **At session start,** jig-core checks each registered section that is in the
  file. A section that fails is reported with the file and the key, `section()`
  returns `undefined`, and the plugin uses its defaults. The rest of the file
  still loads.
- **A top-level key that neither jig-core nor a plugin registered** is an
  unknown field.
- **A plugin cannot register a name jig-core uses itself:** `environments`,
  `rules`, `classify`, `secrets`, `records`, `spill`.
- **Order does not matter.** A plugin that loads before jig-core waits for it,
  and a section registered after the file was read is checked at once.

### Environment variables

| Variable | Meaning |
|---|---|
| `JIG_STATE_DIR` | The state folder. Default: `${XDG_STATE_HOME:-~/.local/state}/jig`. Folders are private (0700) and files too (0600) |
| `JIG_AGENT_ROLE` | The role of this agent, such as `reviewer`. Default: `main`. Written to every record. A child agent is started with it set |
| `JIG_PARENT_SESSION` | The session that started this one. Written to every record of a child agent |
| `PI_CODING_AGENT_DIR` | Pi's own setting for its agent folder, and so for where `jig.json` is |
| `BROWSER` | The program that opens a rendered preview. A name, optionally with arguments, and `%s` for the address. Default: `xdg-open`, or `open` on macOS |

A plugin can own a section of this file too, such as `memory` for
`jig-memory`. It registers the section with a check function, and jig-core
reports any top-level key that no plugin registered as unknown. A section with
errors is reported with its keys named, and the plugin uses its defaults.

## Sign-in services

Some systems are signed in to by code, not by a stored password: a single
sign-on gateway, for example. A company plugin supplies that code as a
**sign-in service**.
- **The company plugin registers it** with `signIn.register(name, service)`.
  Registering the same name again replaces the service.
- **A tool asks for it by name,** with `signIn.headers(name, { system, url },
  signal)`, when its configuration names a sign-in service instead of a secret
  reference. Tools such as `jig-jira` and `jig-logs` do this. The answer is the
  headers that authenticate that one request. Ask again for the next request:
  the service decides when a token has expired.
- **The values are hidden like secrets.** Each header value is registered with
  the redactor before it is returned, so it is removed from every later result
  with the same encodings as a secret (see
  [What happens to a result](#what-happens-to-a-result)). The token in an
  `Authorization` header is hidden on its own too, in case a server repeats it
  without the scheme. An empty value is not registered.
- **An error never shows a value.** An unknown name is an error that lists the
  names registered. A service that throws is an error that names the service
  and carries its message. A header whose value is not a string is an error
  that names the header.

## What asks, what is blocked

The default table:

| Effect | local | external | test environment | production |
|---|---|---|---|---|
| read | allow | allow | allow | allow, always masked |
| write | allow | ask | ask | **deny, fixed** |

Unknown tools ask until a rule or the tool's own hints classify them. With no
screen to ask on, "ask" becomes "deny".

A call is decided in this order, and each step can only change what the step
before it gave:
1. the table, or "ask" for a tool nothing classified;
2. the tool's own `atLeast`, which can only be stricter;
3. the first matching rule, which can be stricter or looser;
4. a session allow, which turns an ask into an allow;
5. the floor: a production write is denied, an unknown tool is allowed only by
   a rule that names it exactly, and an ask with no screen is denied.

### The screens

- **Dialog:** Pi's selector with the header and the summary. Allow, Allow for
  this session, or Decline.
- **Review screen:** for a preview with a body, or when a rule or the tool asks
  for it, in the terminal interface. A scrollable preview; `y` allows, `s`
  allows for the session, `n` or Esc declines, `o` opens the rendered preview
  in the browser. The browser only shows: the page is a local file with no
  script and no form, and the answer is always given in Pi.
- **Form:** shown with Pi's selector in this version.
- **Hosts without the terminal interface (RPC)** use the selector for every
  kind. A review question then shows the first 20 lines of the body in it.
- **After Decline,** you may type a reason. The model reads it. It is not
  recorded.
- **One question at a time.** Calls from one message can run together, so
  questions wait in a queue.
- **A preview** that a tool builds gets 15 seconds. If it fails you see
  "preview unavailable: <reason>" and can still decide. A tool without a
  preview gets a summary made from the call, with its arguments.
- **Invalid input is not asked about.** A tool's preview that throws a
  `TypeError` says the input is invalid: the call is blocked with the tool's
  message, and nobody is asked.
- **A tool's own page.** A tool can render its preview itself, such as Jira
  wiki markup turned into HTML. `o` then opens that page. Tags that could run,
  load or navigate are removed from it, and the page's policy blocks scripts
  and requests as well.

## What happens to a result

After a tool runs, jig-core changes the result in this order, and replaces it
only when something changed:
1. **Redact.** Every resolved secret value, with its base64, base64url,
   URL-encoded and hex forms, and strings of an unmistakable shape: GitHub
   tokens, AWS access key ids, private-key blocks, JWTs and Slack tokens. This
   covers the text, the structured content and the details, however deep.
2. **Mask,** for production results and for a test environment set to `mask:
   true`, unless the tool declares that it masks its own results. An image
   cannot be masked, so it is replaced by a note.
3. **Cap.** Text over 50 000 characters is cut to its first 8 000, with a line
   that names the spill file and says to read it with the `read` tool. The file
   is `<state folder>/spill/<session>/<tool call id>.txt`, private, and holds
   the text as the model would have seen it. Pi's own `read`, `bash`,
   `powershell`, `grep`, `find` and `ls` cut their own output and are left
   alone.

If a step cannot be done, the result is withheld and the model reads "result
withheld: it could not be masked" (or "redacted"). Pi lets an unchanged result
through when a hook fails, so jig-core never leaves a failure to Pi.

## Masking

Production results are masked before the model or a session file sees them. Only
**customer personal data** is masked. Identifiers never are, so a ticket stays
debuggable. The code is in `src/mask/`.

| Found | Becomes |
|---|---|
| Email addresses | `email#3fa9c1` |
| Phone numbers: in a phone field, written with `+` and a country code, or in a North American format | `phone#3fa9c1-0132`. The last four digits stay, so a number can still be matched to a ticket |
| Names in name fields, usernames and logins | `name#3fa9c1`, `user#3fa9c1` |
| Public IP addresses, IPv4 and IPv6 | `ip#3fa9c1` |
| Card numbers: in a card field, or digit groups that pass the Luhn check | `card ****1111` |
| Street addresses, coordinates, dates of birth, government and bank identifiers, card security codes and expiry, health and biometric data, credentials and tokens | `[removed:address]`, `[removed:geo]` and so on. Nothing of the value is kept, not even a state or country |
| Fields a company plugin names (below) | `personal#3fa9c1` |

**Never masked:**
- identifiers: names ending in `id`, UUIDs, ObjectIds, trace ids, SKUs, device
  identifiers such as MAC and IMEI, and bare runs of digits of any length;
- internal IP addresses;
- business names: company, product, account and location names.

How it decides:
- **Field names are judged by their words.** `crmAccountId` is crm, account, id,
  never a substring such as `mac`. A last word that describes a value
  (`phoneType`, `emailVerified`) keeps the field out of the rules.
- **Text is scanned as well.** That covers JSON inside a log line, URL query
  strings, `key=value` pairs and free text, with percent-encoding decoded up to
  three layers. Names are found by field name only: a name written inside a
  free-text note is not recognised.
- **Tokens stay the same all day.** A token is the first three bytes of an
  HMAC-SHA256 of the category and the value, under a random key for the UTC day.
  The same email, phone number or IP address gives the same token in every
  result and every spelling (case, spacing, IPv6 notation), and a different
  token tomorrow. The key is 32 random bytes in `<state>/mask/<YYYY-MM-DD>.key`
  (file 0600, folder 0700), and keys older than two days are deleted.
- **A company plugin adds field names** that hold personal data in its own data,
  with `config.addMaskFields(fields)`. They are compared without case or
  separators, beat every built-in rule, and their values become `personal#`
  tokens. They apply to the next result, and tokens do not change, because the
  key is the day's. A name the masker refuses (one with no letters or digits)
  is left out, and `/jig` shows it as a start-up problem. The other names still
  apply.
- **It fails closed.** A string whose structure cannot be parsed safely
  (malformed percent-encoding, JSON cut off mid-object, an unterminated quote)
  becomes `[removed:unparseable]`, and only that string. A result over 16 MiB,
  2 million values or 64 levels of nesting, or a value that is not JSON-like,
  makes masking throw, and the caller drops the whole result.

## Commands

| Command | What it does |
|---|---|
| `/jig` | Status: loaded plugins, number of tools governed, tools still on the unknown default, open watches (and how many are paused or wait for their plugin), configuration errors, and problems with saved watches |
| `/jig rules [tool]` | Effective decision per tool and action, with where each came from: declaration, rule, hint or default. A tool whose schema lists its actions gets a line for each. A declared tool that classifies from the call itself says so |
| `/jig records` | Where today's records are, and a one-line summary: calls, errors, questions asked, time waited |

## Records

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
or a CI run's conclusion. They are never free text. A string over 64
characters is dropped, and so is anything that is not a number, a flag or a
string.

A record never contains tool arguments or tool output. An error is kept as its
kind plus one masked and redacted line of at most 200 characters.

### Fields

| Field | Lines | Meaning |
|---|---|---|
| `id`, `kind`, `time` | all | A unique id, `call` or `turn`, and the time in ISO 8601, UTC |
| `session`, `parentSession`, `agentRole`, `ticket` | all | The Pi session id; `$JIG_PARENT_SESSION` when set; `$JIG_AGENT_ROLE` (default `main`); the ticket set with `setTicket` |
| `tool`, `action`, `plugin` | call | What was called. `plugin` is the one that declared the tool, else where Pi says the tool came from |
| `environment`, `environmentKind`, `effect` | call | Where it acted (the tool's own name for it and the kind behind it), and `read` or `write` |
| `decision`, `decisionSource` | call | `allow`, `ask` or `deny`, and where it came from: `table`, `rule`, `tool`, `session`, `unknown` or `floor` |
| `approval`, `answer`, `waitedMs` | call | When it asked: `dialog`, `review` or `form`; `allow`, `allow-session` or `decline`; the milliseconds the call waited, queue included |
| `outcome`, `errorKind`, `error` | call | `ok`, `error` or `blocked`; the kind of failure; one line |
| `durationMs`, `toolCallId`, `parentToolCallId`, `spill`, `facts` | call | How long the tool ran; Pi's call ids (a nested call is `<parent>/<n>`); the spill file; the tool's facts |
| `model`, `input`, `output`, `cacheRead`, `cacheWrite`, `cost` | turn | The model id, the token counts, and the total cost in dollars |

A field that does not apply is left out. A call that never reached jig-core (an
unknown tool name, arguments that failed Pi's own checks) was never classified:
it has no environment, effect or decision, and its error kind is `not-run`.

Error kinds: `denied` and `no-screen` (a deny), `declined` and `dismissed` (the
answer to a question), `invalid` (the tool's preview found the input invalid,
so nobody was asked), `internal` (jig-core could not decide, so it blocked),
`tool` (the tool ran and failed), `withheld` (the tool ran but its result could
not be masked or redacted) and `not-run`.

Records are kept for `records.retentionDays` and cleaned when a session starts.
If a line cannot be written, the call goes on, and `/jig` says so.

## Security and data

- **The floor holds whatever the configuration says:**
  - production writes are denied;
  - production results are masked;
  - credentials are hidden from `bash`;
  - nothing that needs approval runs without a screen.
- **Approvals happen only inside the waiting call.** There is no web endpoint
  that could approve.
- **Anything that fails in jig-core blocks the call,** with "jig-core could not
  decide: ...". Nothing runs because jig-core could not tell whether it may.
- **Programs run without a shell,** with a timeout and an output cap. The
  environment is a short allow-list (`PATH`, `HOME`, `USER`, `LANG`, `TZ`,
  `TMPDIR` and the XDG folders), plus what the calling tool passes. Git also
  gets the user's ssh agent and ssh command. A program found only in a folder
  the agent can write to is not run, and such a folder is left out of `PATH`.
  A program that takes too long is stopped with its whole process group, and
  the result has `timedOut: true` and exit code 124. Output beyond the cap
  (10 MiB unless the caller sets it) is cut, and ends with `[output cut at N
  bytes]`.
- **Git runs with hooks and `core.fsmonitor` off and prompts disabled,** and
  refuses a repository whose own `.git/config` sets a command or redirects a
  remote. `exec.run("git", ...)` and `exec.run("gh", ...)` get the same checks
  as `exec.git`.
- **Records and saved watches stay on this machine,** and `jig-core` sends nothing
  anywhere.

## Not built yet

- **Command rules for `bash`** that split a shell string with tree-sitter.
- **Hiding a tool that the rules deny completely** from the model.
- **The form screen.** The form kind uses the selector for now.

## Layout

```text
jig-core/
  src/
    contract.ts, client.ts       what other plugins import
    index.ts, api.ts, state.ts   the extension, the API it publishes, what it remembers
    gate.ts, results.ts          the hooks: before a tool runs, after it ran
    classify.ts, decide.ts       the rules, as pure functions
    config.ts, environments.ts   jig.json, and the environments it names
    approvals.ts, review.ts,
    preview.ts, preview-html.ts  asking you, and the page for the browser
    secrets.ts, signin.ts,
    redact.ts, cap.ts,
    records.ts                   secrets and sign-in, and what happens to data
    exec.ts, git-config-guard.ts running programs and git safely
    commands.ts                  /jig
    paths.ts, errors.ts          the state folder and private files; messages from thrown values
    mask/                        the masker, written separately
    watch/                       the watch engine and the `watch` tool: engine.ts polls and decides,
                                 store.ts saves, outbox.ts spaces the messages, message.ts and
                                 clean.ts write and clean the text, tool.ts is the tool
  test/                          unit tests, and tests inside a real Pi session
```
