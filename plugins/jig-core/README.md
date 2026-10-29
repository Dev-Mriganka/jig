# jig-core: the tool manager

**Status: design.** This README is the specification; there is no code yet.

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
| Classify | Gives each call an environment and an effect. Sources, in order: the tool's own declaration, a rule in your configuration, the tool's hints, the default |
| Rules | Turns environment × effect, plus your rules, into allow, ask or deny, bounded by the floor |
| Approvals | Asks you inside the waiting call: dialog, review screen or form ([Approvals](../../docs/approvals.md)) |
| Secrets | Resolves secret references for Jig's tools through configured backends ([Secrets](../../docs/secrets.md)) |
| Mask | Replaces customer personal data in production results with tokens. Jig's tools mask their own results; this step is the backstop for every other tool |
| Redact | Removes every resolved secret value from output |
| Cap | Cuts long output for the model and saves the full result to a spill file |
| Record | Writes one line per tool call and per model turn, for `jig-lens` |

## What other plugins get from it

The contract for a Jig tool is:
- how the tool declares the environment and effect of each action;
- how it asks for a secret;
- how it gives a preview for the review screen;
- how it adds facts to its record.

The contract for every plugin is:
- the record format;
- the events published on Pi's event bus, so other plugins can react to
  calls, decisions and results.

Plugins import only this contract, never each other.

## Prerequisites

- Pi 1.4 or later.
- At least one secret backend, if a Jig tool needs secrets: `pass` on Linux
  first.
- On Linux, a sandbox for `bash`. While Jig is tried beside the existing
  harness, it borrows that harness's.

## Configure

`~/.pi/agent/jig.json`. All fields are optional. Company plugins add
environments and classification rules at start-up.

| Field | Default | Meaning |
|---|---|---|
| `environments` | `local`, `external`, `production` built in | Add environments with a `kind`: `test` or `production`. A test environment can be set to `mask: true`; production masking cannot be turned off |
| `rules` | the default table in [Permissions](../../docs/permissions.md) | A list of rules, most specific first. Each one names a `tool`, optionally an `action`, `environment` or `effect`, and gives a `decision` (`allow`, `ask`, `deny`) and optionally an `approval` kind (`dialog`, `review`, `form`). Rules that would lower the floor are refused at load, with the file and the key named |
| `classify` | none | How to classify tools Jig did not write: `tool`, optionally `action`, a `param` and `value` (or `pattern`), and the resulting `environment` and `effect` |
| `secrets.backends` | `["pass"]` | Which backends may resolve references |
| `records.retentionDays` | 90 | How long record files are kept |
| `spill.retentionDays` | 7 | How long spill files are kept |

An unknown field is an error. It names the file and the key, and the plugin
starts with the defaults rather than guessing.

## What asks, what is blocked

The default table:

| Effect | local | external | test environment | production |
|---|---|---|---|---|
| read | allow | allow | allow | allow, always masked |
| write | allow | ask | ask | **deny, fixed** |

Unknown tools ask until a rule or the tool's own hints classify them. With no
screen to ask on, "ask" becomes "deny".

## Commands

| Command | What it does |
|---|---|
| `/jig` | Status: loaded plugins, number of tools governed, tools still on the unknown default, configuration errors |
| `/jig rules [tool]` | Effective decision per tool and action, with where each came from: declaration, rule, hint or default |
| `/jig records` | Where today's records are, and a one-line summary: calls, errors, questions asked, time waited |

## Records

One JSON line per event, in `~/.local/state/jig/records/<YYYY-MM-DD>.jsonl`.
The file is private to you, and only `jig-core` writes it. Every line has its
own `id`, so a reader that imports a line twice still counts it once.

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
or a CI run's conclusion. They are never free text.

A record never contains tool arguments or tool output. An error is kept as its
kind plus one masked line.

## Security and data

- **The floor holds whatever the configuration says:**
  - production writes are denied;
  - production results are masked;
  - credentials are hidden from `bash`;
  - nothing that needs approval runs without a screen.
- **Approvals happen only inside the waiting call.** There is no web endpoint
  that could approve.
- **Records stay on this machine,** and `jig-core` sends nothing anywhere.
