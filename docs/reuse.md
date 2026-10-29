# Reuse: existing packages before our own

Checked on 2026-10-30. About 2,200 of the 13,000 Pi packages on npm were
sampled, and the strongest were read in source or README. Nothing has been
installed or run yet.

Each package gets one of four verdicts:
- **use as is;**
- **use and extend;**
- **borrow the pattern;**
- **skip.**

Download counts are per week, from npm.

## Summary

| Need | Verdict | Package |
|---|---|---|
| Tool manager | build `jig-core`, borrowing the patterns | `@gotgenes/pi-permission-system` |
| Question and approval forms | use as is, on trial | `@adeildo/pi-ask-questions` |
| Git, GitHub and CI | port the existing harness's tools, borrowing patterns | several, below |
| Observability, today | use as is | `@twkrash/pi-session-inspector` |
| Observability viewer | use as is | Grafana with a SQLite data source; Datasette as the fallback |
| Secret backends | build a small backend seam, borrowing the patterns | `@ian-pascoe/pi-secret` and others |

## Tool manager

`@gotgenes/pi-permission-system` is the strongest candidate: version 42.0.0,
about 10,600 a week, MIT licence. It offers:
- allow, ask or deny on every tool call: Pi's tools, MCP tools, skills, and
  any package's tools;
- `bash` split with tree-sitter, so chains and substitutions are judged one
  command at a time;
- rules on paths;
- an inline dialog, with a fallback for RPC hosts, and deny when there is no
  screen;
- decision events, and a chain of pluggable authorizers.

**Verdict: borrow the patterns; do not build on it.**
- **Environments are a stated non-goal,** and nothing outside the package can
  change its policy.
- **It judges another package's tool by name only.** Jig decides per action
  and per argument, such as `env: "prod"`.
- **It changes fast:** about 30 major versions since June 2026, six of them in
  October, from one maintainer.
- **Two gates mean two dialogs** competing for Pi's single dialog slot, and Pi
  does not arbitrate between packages.

Also read, for patterns:

| Package | Pattern |
|---|---|
| `pi-permission-modes` | Project configuration can only tighten |
| `@amaster.ai/pi-security` | Rules on arguments and risk |
| `@adeildo/pi-ask-permission` | A reason with "no" that the model reads; "always yes" limited to a session or project |
| `@ian-pascoe/pi-guardian` | A reviewer model; it must load last |

## Question and approval forms

`@juicesharp/rpiv-ask-user-question` is in use today and remains the reference.
Version 2.15.0 is current; you run 2.13.8. It has about 54,000 downloads a
week. It offers:
- a tab per question and a review tab;
- free text and notes;
- markdown previews;
- a plain fallback for RPC hosts.

| Package | A week | Verdict | Why |
|---|---|---|---|
| `@adeildo/pi-ask-questions` | 1,291 | **use as is, on trial:** Jig's forms build on it, and it is the nicer-looking question tool | A deliberate port of rpiv's question format into a framed dialog: scrolling previews, a note per option, and it opens while the model is still writing. Its README says other packages can open it through `@adeildo/pi-kit`. Costs: the tool is named `ask_questions`, and there is no global note, no collapse key, and English only |
| `pi-interview` | 5,521 | skip for approvals | The best-looking, in a browser window. But it answers through a local server that the agent's shell can reach |
| `pi-ask-user` | 3,575 | skip | Search and timeouts, but no markdown previews |
| `supi-ask-user`, `pi-ask`, `pi-questions`, `pi-agent-ask` | under 1,000 | skip | Look-alikes, or a different way of working |

## Git, GitHub and CI

No package covers the list in [`jig-git`](../plugins/jig-git/README.md), and
none watches CI in the background until a finish line. `jig-git` ports the
existing harness's tools and borrows these patterns:

| Package | Pattern |
|---|---|
| `@henryqw/pi-pr` | Merge pinned to the head commit; replying to and resolving review threads |
| `@pedro_klein/pi-github` | Reconciling a write whose outcome is unknown |
| `@estebanforge/pi-git-me` | An editable preview before each write |
| `@gotgenes/pi-github-tools` | Backoff and a structured timeout when polling CI |

## Observability

**Today: `@twkrash/pi-session-inspector`, as is** (version 1.6.0, MIT).
- **What it shows:** it reads Pi's own session files, with cost and tokens per
  session and tool calls with their duration and errors, in Pi or on a local
  page.
- **What it lacks:** tickets and rule decisions. `jig-lens` adds those.
- **Before leaving its local page running,** check how the page is protected,
  because the agent's shell can reach `127.0.0.1`.

Patterns borrowed:

| Package | Pattern |
|---|---|
| `@spences10/pi-telemetry` | A SQLite schema of runs, turns and tool calls |
| `pi-coedit-ledger` | Cost per commit, kept in git notes |
| `@narumitw/pi-analytics` | JSON lines that hold no content |

Skipped: exporters that send data to a service (Braintrust, Raindrop,
Langfuse, OpenTelemetry to a backend).

The viewer for `jig-lens` is Grafana with a SQLite data source; see
[`jig-lens`](../plugins/jig-lens/README.md).

## Secret backends

No package covers `pass`, the macOS Keychain, 1Password and environment
variables together. `jig-core` builds a small backend seam and borrows:

| Package | Pattern |
|---|---|
| `@ian-pascoe/pi-secret` | A provider seam; grants you approve; redaction that also catches encoded forms of a secret, such as Base64 or URL encoding |
| `@spences10/pi-redact` | Patterns for secret shapes, such as API keys, that Jig has not resolved itself |
| `@prjct.app/pi-secrets`, `@jmcombs/pi-1password` | How to call the macOS Keychain and the 1Password CLI |

Not borrowed: putting secrets into any tool's arguments, `bash` included.
Credentials stay out of `bash` (see [Permissions](permissions.md)).

## Not verified

- **Behaviour comes from source, docs and READMEs only.** Nothing has been run.
- **`pi-ask-questions`:** whether other packages can open it, and how it
  behaves on Pi 1.4.
- **WSL2:** the Linux Secret Service has not been tried there.
