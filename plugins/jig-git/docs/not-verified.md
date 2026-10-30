# Not verified yet

What the tests of `jig-git` do not cover. Back to the
[jig-git overview](../README.md).

- **Pi's event bus** was checked against an older Pi (1.2), not 1.4. `jig-git`
  only publishes `jig-git:pushed` with `pi.events.emit`; the watch messages that
  start a turn are `jig-core`'s, and the listener is `jig-ops`'s.
- **GitHub itself.** Nothing here has been run against GitHub.
  - The queries for pull request comments, replies and resolving threads
    (GraphQL), and reading a pull request's roll-up with `gh pr view`, are
    written from GitHub's documentation.
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
