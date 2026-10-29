# jig-git: git, GitHub and CI

**Status: design, waiting for research.** The tool tables below get filled in
from an inventory of the git, GitHub and CI work in your Pi sessions, together
with standard developer needs. Existing Pi packages are being compared too (see
[Reuse](../../docs/reuse.md)); if one is better than writing our own, it is
used instead.

## Scope

| Group | Covers |
|---|---|
| Local git | status, diff, log, branches, commit, stash, rebase, merge, tags, fetch and sync, push |
| Pull requests and reviews | create, edit and view PRs; read and write comments and review threads; merge when allowed |
| CI and checks | the state of a PR's checks; watching a run until it finishes; reading a failed job's log |
| Tags and releases | seeing new tags and releases, and creating them when allowed |

Every tool declares the environment and effect of each action to `jig-core`.
Reads are allowed. A push, a comment or a merge is a write to `external`, so it
asks you by default.

## Watching CI until it finishes

A watch runs in the background:
- **It watches** a PR's checks or one CI run, without you asking "is it done?".
- **It tells you** when the result arrives: passed, failed (with the failing
  job and the start of its log), or timed out.
- **It notices** when a tag or image appears.
- **It publishes an event** on Pi's event bus, so other plugins can act on it.

What happens next is a company decision, not git's. For example, a company
deploy tool can listen for "image ready" and deploy to the first shared test
environment **automatically only if a policy setting allows it**, and never to
production.

## Not in this plugin

Anything specific to one company goes in that company's private plugin:
- its CI pipelines beyond GitHub's checks;
- its deploy repositories;
- its test environments.

## Tools

*To be written from the research: each tool with its actions, a one-line
description per action, its default decision, and the evidence for including
it.*
