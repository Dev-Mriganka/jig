# Background: where the tools come from

Back to the [jig-git overview](../README.md).

The tool list comes from two sources:
- an inventory of two months of real sessions: about 26,000 tool calls, plus
  about 3,800 `git` and 200 `gh` commands run through `bash`;
- standard developer needs.

## What the sessions showed

- **Most of `git` and `pr` already exists** in the existing harness, which has
  run about 225 of these calls. It is ported, not redesigned.
- **What was missing is the wait.** Nothing watched GitHub CI, so you were the
  signal: about 15 "is it done?" nudges in one month. One build was ready 7
  minutes after the push and reached the agent 2 hours 16 minutes later.
  - The wait is the CI watch, which started here and moved to `jig-ops` with the
    rest of CI.
  - This plugin announces the push that starts it.
- **"All checks done" is the wrong finish line.** Six background
  `gh pr checks --watch` runs never finished. In one pull request, two of ten
  checks were still pending 20 hours after the build the next step needed had
  passed. The finish lines are in [Watching CI](../../jig-ops/docs/ci.md#watching-ci).
- **The agent stops using `bash` for a job once a tool covers it.** `gh` calls
  through `bash` fell from 148 to 3 after the `pr` tool arrived.
- **Tags and releases were barely used:** one `git tag` and no `gh release`. The
  `release` actions rest on standard practice.

`git`, `pr` and `release` are always loaded, and so is `jig-core`'s `watch`.
In the sessions, a "tool not found" cost the agent extra calls.

## Ported from the existing harness

- **A table of parameters per action,** with errors that show the correct
  usage.
- **A hardened git runner,** now `jig-core`'s `exec.git`, which every git call
  goes through. Every `gh` call, and every `glab` call, goes through `jig-core`'s `exec.run`.
  - They run from an argument list, never a shell, with hooks, `core.fsmonitor`
    and prompts switched off.
  - They refuse a repository whose `.git/config` would run a command.
    [Running programs](../../jig-core/docs/running-programs.md) has the
    details.
- **Preview, then run.** A write shows what it will do, and refuses if anything
  changed since the preview.
- **A lost reply is checked with one read, never retried.**
- **A closed grammar for what `clone` accepts.** `owner/name`, or an ssh or
  https URL of `github.com` or the clone host. The URL git receives is built
  from `cloneHost`; the model never names a host or a transport. git clones
  into a temporary folder and renames it into place only when it finished.
- **Check states mapped to pass, fail, pending and skipped.** The map moved to
  `jig-ops`; `pr view` keeps the part that counts a pull request's roll-up.
- **Pull request comments assembled with their line comments and threads.**
