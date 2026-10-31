# jig-core: the tool manager

**Status: built.** Unit tests, and tests inside a real Pi 1.4 session with a
scripted model, pass. Watches are tested only against a fake Pi so far, and
three parts are not built (see [Later](#later)).

`jig-core` governs every tool call the agent makes, whoever wrote the tool: Pi's
own tools, Jig's tools, and tools from other packages. Every other Jig plugin
needs it.

For each call it works out where the call acts and whether it reads or writes,
applies your rules, asks you when a rule says so, masks and redacts the result,
and records the call. For example, `git push` is a write to `external`, so
`jig-core` shows you the push and waits for your `y` before it runs.

![Every tool call passes through jig-core's hooks before and after it runs](../../docs/img/one-call.svg)

*One call, end to end: it is classified, decided and, when a rule says ask, put to you before it runs; what comes back is redacted, masked, capped and recorded. [Architecture](../../docs/architecture.md) shows how the hooks fit; [Permissions](../../docs/permissions.md) has the rules and the floor.*

## Tool: `watch`

Plugins start watches from their own tools, such as `jig-ops`'s `ci watch`.
This tool lists and stops the watches of every plugin.

| Action | Kind | What it does |
|---|---|---|
| `list` | read | This session's open and paused watches, and those that finished in the last 24 hours |
| `stop` | local write | Cancels an open or paused watch, given its `id`. The agent is not told |

## Commands

| Command | What it does |
|---|---|
| `/jig` | Status: tools governed, plugins loaded, open watches, configuration problems |
| `/jig rules [tool]` | The effective decision per tool and action, and where each came from |
| `/jig records` | Where today's records are, and a one-line summary of the day |

What each one shows in full is in the
[configuration reference](docs/configuration.md#the-jig-commands).

## Rules

- **The floor holds.** Whatever the configuration says, production writes are
  denied, production results are masked, credentials are hidden from `bash`,
  nothing that needs approval runs without a screen, and Pi's file tools
  refuse protected paths (see [Permissions](../../docs/permissions.md)).
- **A plugin's gate only tightens.** A gate sees each call after the rules and can make an allow into an
  ask or a deny, never the reverse; one that fails denies the call ([Plugin contract](docs/plugin-contract.md#gates)).
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
- **Nothing leaves this machine on its own.** Records and saved watches stay
  here. `jig-core` sends only the requests that plugins ask for
  (`http.request`), with a credential it reads for them. It never signs in and
  stores no credential ([Decisions](../../docs/decisions.md)).

## Configure

`jig.json` in Pi's agent folder: `~/.pi/agent/jig.json`, unless
`PI_CODING_AGENT_DIR` points elsewhere. A separate Pi profile has its own file.
All fields are optional.

| Field | Default | Meaning |
|---|---|---|
| `environments` | `local`, `external`, `production` | Add test or production environments, each with a `kind` |
| `rules` | the table in [Permissions](../../docs/permissions.md) | `allow`, `ask` or `deny` per tool, action, environment or effect |
| `classify` | none | How to classify tools Jig did not write |
| `protectedPaths` | the [defaults](../../docs/permissions.md#protected-paths) | More paths for Pi's file tools to refuse |
| `secrets.backends` | `["pass"]` | Which backends may resolve secret references |
| `secrets.commands` | none | The commands that `cmd:<name>` may run, by name |
| `records.retentionDays` | 90 | Days record files are kept, from 1 to 3650 |
| `spill.retentionDays` | 7 | Days spill files and rendered previews are kept |

What each field means, with its limits, is in the
[configuration reference](docs/configuration.md#the-fields). An unknown field is
an error. It names the file and the key, and the plugin starts with the defaults
rather than guessing. So is a wrong type or value.

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

It needs Pi 1.4 or later, a secret backend if a Jig tool needs secrets (`pass`
on Linux first), and a sandbox for `bash`, which [`jig-sandbox`](../jig-sandbox/README.md)
is. Without one, `/jig` and session start say plainly that `bash` is not sandboxed.

## Company part (in the company plugin)

- environments, rules and classification rules for its own tools, and which of
  its targets count as production;
- field names that hold personal data in its systems, for masking;
- sign-in services and transports for its systems, and tunnels (a forward, or a SOCKS proxy) for its
  databases;
- defaults for other plugins' sections of `jig.json` (`config.addSectionDefaults`), which your own
  section is laid over;
- secret commands (`config.addSecretCommands`) and protected paths
  (`config.addProtectedPaths`) for its own tools.

## Later

- **Command rules for `bash`** that split a shell string with tree-sitter.
- **Hiding a tool that the rules deny completely** from the model.
- **The form screen.** The form kind uses the selector for now.

## Layout

```text
jig-core/
  src/      the hooks (gate, results), classify and decide, gates (the checks plugins add), config, approvals,
            secrets, sign-in, transports, redact, records, exec; mask/ (the masker), watch/ (the engine and its
            tool), kit/ (helpers plugins import)
  test/     unit tests, and tests inside a real Pi session
  docs/     the detail pages below
```

## More detail

- [Code map](docs/code-map.md): every file, who calls it, and one tool call followed through the gate
- [Watches](docs/watches.md): kinds, polling, finish lines, messages, saving
- [Credential sources](docs/sign-in-and-transports.md): where a request's credential comes from, and why Jig never signs in
- [What asks](docs/approval-screens.md): the order of a decision, and the screens
- [Results](docs/results.md): what happens to a result: redact, mask and cap
- [Masking](docs/masking.md): what counts as personal data, and the tokens
- [Records](docs/records.md): the line per call and per turn, facts, error kinds
- [Configuration](docs/configuration.md): the fields, rule matching, secrets, sections, variables
- [Running programs](docs/running-programs.md): no shell, and the checks on git
- [Plugin contract](docs/plugin-contract.md): what a plugin gets from `jig-core`
- [Reuse](../../docs/reuse.md#tool-manager): what `jig-core` borrows from
  `@gotgenes/pi-permission-system`, and why it is not a dependency
