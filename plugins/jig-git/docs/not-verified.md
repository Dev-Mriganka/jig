# Not verified yet

What the tests of `jig-git` do not cover. Back to the
[jig-git overview](../README.md).

- **Pi's event bus** was checked against an older Pi (1.2), not 1.4. `jig-git`
  only publishes `jig-git:pushed` with `pi.events.emit`; the watch messages that
  start a turn are `jig-core`'s, and the listener is `jig-ops`'s.
- **The comment watch** was tested against answers written in the shape of
  GitHub's REST API and a fake `gh`, not against GitHub. Not seen:
  - the `304` that GitHub gives a conditional request for these four endpoints,
    and that it is not counted against the rate limit (the same assumption as the
    CI watch);
  - a rate limit's real headers, and a secondary limit's message;
  - the GraphQL read that finds the thread of a line comment (written from the
    documentation of `reviewThreads`), and a pull request with more than 100
    threads, which shows only the first 100;
  - a pull request with more than 100 reviews or conversation comments, which
    shows the oldest 100 of each, and GitHub Enterprise Server;
  - a message reaching the agent through a real Pi: the watch is tested with a
    fake `jig-core`, and once with `jig-core`'s own watch engine and a clock moved
    by hand, whose messages are caught before Pi.
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
