# Not verified yet

What the tests of `jig-git` do not cover. Back to the
[jig-git overview](../README.md).

The tests in `test/` run against temporary repositories and recorded GitHub answers. The tests in `test/it/` run the reads against real
GitHub, in the `integration` job of CI (see [Integration tests](../../../docs/integration-tests.md)). No test writes to GitHub: no push,
no pull request, no comment, no release.

## Verified in CI

| What | Proved by |
|---|---|
| `fetch`, `log`, `branches` and `status` of a clone of a small public repository, made with git over https | `github.test.ts` |
| `release tags` from the tags that came with that clone | `github.test.ts` |
| `clone` over ssh when GitHub does not know the key: one line of advice, no folder and no half-made clone left | `github.test.ts` |
| `pr list`, `pr view` and `pr comments` (the GraphQL query) of a well-known repository, with the token a run gets | `github.test.ts` |
| `release releases`, listed and one in full | `github.test.ts` |
| `gh`'s words for a pull request that does not exist | `github.test.ts` |
| That every read here is classified a read, and the writes beside them are writes | `github.test.ts` |

`clone` over ssh to a repository the key can read was run once, by hand, on a developer machine: it cloned a small public repository and
put it in place. A test run has no key GitHub knows, so CI runs only the refusal.

## What is still not verified

- **Pi's event bus** was checked against an older Pi (1.2), not 1.4. `jig-git`
  only publishes `jig-git:pushed` with `pi.events.emit`; the watch messages that
  start a turn are `jig-core`'s, and the listener is `jig-ops`'s.
- **GitHub's writes.** Replies, resolving a thread, comments, reviews, a merge, a push and a release are written from GitHub's
  documentation and were never sent to GitHub.
  - Comments and reviews are read from the first page only.
  - `gh api` with ETags, rate limits and branch protection moved with CI; see
    [jig-ops](../../jig-ops/docs/not-verified.md).
- **What `jig-core` does with a call whose preview throws.** A call with the
  wrong parameters throws from its preview, so the user is not asked about it.
  This assumes `jig-core` blocks such a call and shows the model the message.
  `execute` refuses it either way.
- **The environment `jig-core` gives a program.** `gh` needs its sign-in
  (usually `HOME`). For git calls that reach a remote, `jig-git` passes the ssh
  agent socket, which is a path and not a secret.
