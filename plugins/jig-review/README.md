# jig-review: reviewing code in the browser

**Status: design.**

A browser review of the agent's changes:
- a file tree;
- split or unified diffs;
- line comments, then Ask (one comment now) or Finish review (all of them);
- Approve.

The agent answers each comment, and a new round shows what changed.

## Tools

| Tool | What it does |
|---|---|
| `start_interactive_code_review` | Opens the review in your browser. Its result never contains the page link, so the agent cannot use the page |
| `record_interactive_review_resolution` | The agent records how it handled each comment: fixed, answered, or won't fix |

## Commands

`/code-review` takes a ticket, a folder, or one of these scopes:

| Scope | What it reviews |
|---|---|
| `--branch` | everything since the branch left the main branch |
| `--staged` | staged changes |
| `--unstaged` | unstaged changes |
| `--touched` | the files the agent edited last |

`/code-review settings` opens the review settings.

## Security

The page is served on `127.0.0.1`, on a random port. Its link carries a
per-session secret, which is exchanged for a cookie. The link goes only to you,
and requests from another host or origin are refused.

Approve is a click in the page, so it is protected only by the secret never
reaching the agent. When `jig-flow` arrives, the approval that opens a gate
becomes a `y` inside the waiting call, as everywhere else (see
[Approvals](../../docs/approvals.md)).

## Origin

Adapted from `@dbaida/pi-interactive-code-review` (MIT).

## Layout (planned)

```text
jig-review/
  src/      coordinator, review store, local server, tools
  web/      the browser page, built to static files
  test/
```
