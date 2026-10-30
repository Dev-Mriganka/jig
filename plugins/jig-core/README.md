# jig-core: the tool manager

**Status: built.** Unit tests, and tests inside a real Pi 1.4 session with a
scripted model, pass. Watches are tested only against a fake Pi so far, and
three parts are not built (see [Later](#later)).

`jig-core` governs every tool call the agent makes, whoever wrote the tool: Pi's
own tools, Jig's tools, and tools from other packages. For each call it works
out where the call acts and whether it reads or writes, applies your rules, asks
you when a rule says so, masks and redacts the result, and records the call. For
example, `git push` is a write to `external`, so `jig-core` shows you the push
and waits for your `y`; a write to `production` is denied without asking. Every
other Jig plugin needs it.

![Every tool call passes through jig-core's hooks before and after it runs](../../docs/img/one-call.svg)

*One call, end to end: it is classified, decided and, when a rule says ask, put to you before it runs; what comes back is redacted, masked, capped and recorded. [Architecture](../../docs/architecture.md) shows how the hooks fit; [Permissions](../../docs/permissions.md) has the rules and the floor.*

## Tool: `watch`

Plugins start watches from their own tools, such as `jig-git`'s `checks watch`.
This tool lists and stops the watches of every plugin.

| Action | Kind | What it does |
|---|---|---|
| `list` | read | This session's open and paused watches, and the ones that finished in the last 24 hours, oldest first. No parameters |
| `stop` | local write | Cancels an open or paused watch, given its `id`. It ends as `stopped`, and the agent is not told |

## Rules

- **The floor holds.** Whatever the configuration says, production writes are
  denied, production results are masked, credentials are hidden from `bash`,
  and nothing that needs approval runs without a screen.
- **Unknown tools ask.** A tool that nothing classifies counts as a write
  outside the machine, and asks until a rule or its own hints say otherwise.
- **Approvals happen only inside the waiting call.** There is no web endpoint
  that could approve.
- **A failure blocks the call.** Anything that fails in `jig-core` blocks the
  call with "jig-core could not decide: ...". Nothing runs because `jig-core`
  could not tell whether it may.
- **Programs run without a shell,** with a timeout, an output cap and a short
  environment. Git runs with hooks off, and refuses a repository whose own
  configuration would run a command.
- **Records and saved watches stay on this machine,** and `jig-core` sends
  nothing anywhere.

## Commands

| Command | What it does |
|---|---|
| `/jig` | Status: the tools governed and the plugins loaded, tools still on the unknown default, open watches (and how many are paused or wait for their plugin), the configuration file with the state of each plugin section, configuration errors, a failed records write, and problems with saved watches |
| `/jig rules [tool]` | The effective decision per tool and action, with where each came from: declaration, rule, hint or default. A tool whose schema lists its actions gets a line for each. A declared tool that classifies from the call itself says so |
| `/jig records` | Where today's records are, and a one-line summary: calls (with errors and blocked ones), questions asked, time waited for you, and model turns |

## Configure

`jig.json` in Pi's agent folder: `~/.pi/agent/jig.json`, unless
`PI_CODING_AGENT_DIR` points elsewhere. A separate Pi profile has its own file.
All fields are optional.

| Field | Default | Meaning |
|---|---|---|
| `environments` | `local`, `external`, `production` built in | Add environments with a `kind`: `test` or `production`. A test environment can be set to `mask: true`; production masking cannot be turned off. The built-in names cannot be redefined, and an environment a company plugin made production cannot be lowered |
| `rules` | the default table in [Permissions](../../docs/permissions.md) | A list of rules, most specific first. Each one names a `tool`, optionally an `action`, `environment` or `effect`, and gives a `decision` (`allow`, `ask`, `deny`) and optionally an `approval` kind (`dialog`, `review`, `form`). Rules that would lower the floor are refused at load, with the file and the key named |
| `classify` | none | How to classify tools Jig did not write: `tool`, optionally `action`, a `param` and `value` (or `pattern`), and the resulting `environment` and `effect` |
| `secrets.backends` | `["pass"]` | Which backends may resolve references: `pass`, `env`, `keychain`, `op` |
| `records.retentionDays` | 90 | How long record files are kept, as a whole number of days from 1 to 3650 |
| `spill.retentionDays` | 7 | How long spill files and rendered previews are kept, in the same range |

An unknown field is an error. It names the file and the key, and the plugin
starts with the defaults rather than guessing. So is a wrong type or value.

```json
{
  "environments": { "staging": { "kind": "test" }, "dev": { "kind": "test", "mask": true } },
  "rules": [
    { "tool": "deploy", "environment": "staging", "effect": "write", "decision": "allow" }
  ],
  "classify": [
    { "tool": "other_db", "param": "target", "value": "live", "environment": "production", "effect": "read" }
  ]
}
```

## Requires

- Pi 1.4 or later.
- At least one secret backend, if a Jig tool needs secrets: `pass` on Linux
  first.
- On Linux, a sandbox for `bash`. While Jig is tried beside the existing
  harness, it borrows that harness's.

## Later

- **Command rules for `bash`** that split a shell string with tree-sitter.
- **Hiding a tool that the rules deny completely** from the model.
- **The form screen.** The form kind uses the selector for now.

## Company part (in the company plugin)

At start-up, it adds to what `jig-core` knows:
- environments, and which of its targets count as production;
- rules and classification rules for its own tools;
- field names that hold personal data in its systems, for masking;
- sign-in services and transports for its systems.

## Origin

`jig-core` is its own code. It borrows patterns from
`@gotgenes/pi-permission-system` and does not depend on it (see
[Reuse](../../docs/reuse.md#tool-manager)).

## Layout

```text
jig-core/
  src/
    contract.ts, client.ts, index.ts, api.ts, state.ts   what other plugins import; the extension, its API, its state
    gate.ts, results.ts, classify.ts, decide.ts          the hooks, and the rules as pure functions
    config.ts, environments.ts, paths.ts, errors.ts      jig.json, its environments, the state folder
    approvals.ts, review.ts, preview.ts, preview-html.ts asking you, and the page for the browser
    secrets.ts, signin.ts, transports.ts, redact.ts,
    cap.ts, records.ts                                   secrets, sign-in, and what happens to data
    exec.ts, git-config-guard.ts, commands.ts            running programs and git safely; /jig
    mask/                                                the masker, written separately
    watch/                                               the watch engine and the `watch` tool
  test/                                                  unit tests, and tests inside a real Pi session
  docs/                                                  the detail pages below
```

## More detail

- [Watches](docs/watches.md): kinds, polling, finish lines, messages, saving
- [Sign-in and transports](docs/sign-in-and-transports.md): how a company signs in
- [What asks](docs/approval-screens.md): the order of a decision, and the screens
- [Results](docs/results.md): what happens to a result: redact, mask and cap
- [Masking](docs/masking.md): what counts as personal data, and the tokens
- [Records](docs/records.md): the line per call and per turn, facts, error kinds
- [Configuration](docs/configuration.md): rule matching, secrets, sections, variables
- [Running programs](docs/running-programs.md): no shell, and the checks on git
- [Plugin contract](docs/plugin-contract.md): what a plugin gets from `jig-core`
