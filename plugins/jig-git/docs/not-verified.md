# Not verified yet

What the tests of `jig-git` do not cover. Back to the
[jig-git overview](../README.md).

- **Pi's event bus and messages that start a turn** were checked against an
  older Pi (1.2), not 1.4. `jig-git` only publishes `jig-git:artifact-ready`
  with `pi.events.emit`; the messages are `jig-core`'s.
- **GitHub itself.** `gh api` prints a `304` as the status line and headers,
  then `gh: HTTP 304` on standard error, and exits with 1. That was checked
  with gh 2.92 against a local server, and the tests rely on it. Rate limits,
  `X-Poll-Interval` on these endpoints, and polling with a single sign-on
  login have not been tried. `gh run watch` does not support fine-grained
  tokens.
- **Queries written from GitHub's documentation.** The GraphQL queries for
  comments, replies and resolving threads, and the endpoints for branch
  protection and rulesets, have not been run against GitHub. Reviews, comments,
  tags and releases are read from the first page only (100, 100, 100 and 30).
- **Resuming watches on start** is `jig-core`'s. The watch's state is plain
  JSON, and a poll that resumes from a saved state is tested.
- **Which checks are required** is read from the protection and the rulesets
  of the base branch, which was not tried on a real repository. A repository
  that hides them from read access has every check counted. For a pull
  request, `required_only` relies on `gh pr checks --required`.
- **What `jig-core` does with a call whose preview throws.** A call with the
  wrong parameters throws from its preview, so the user is not asked about it.
  This assumes `jig-core` blocks such a call and shows the model the message.
  `execute` refuses it either way.
- **The environment `jig-core` gives a program.** `gh` needs its sign-in
  (usually `HOME`). For git calls that reach a remote, `jig-git` passes the ssh
  agent socket, which is a path and not a secret.
