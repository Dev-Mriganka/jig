# Not verified yet

What the tests of `jig-git` do not cover. Back to the
[jig-git overview](../README.md).

The tests in `test/` run against temporary repositories and recorded GitHub and GitLab answers. The tests in `test/it/` run the reads against
real GitHub, in the `integration` job of CI (see [Integration tests](../../../docs/integration-tests.md)). No test writes to GitHub: no push,
no pull request, no comment, no release.

**GitLab itself was never reached:** there is no account, so no test, not even a read, goes to a GitLab server (see
[GitLab, not verified](#gitlab-not-verified)).

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
- **GitHub's writes.** Replies, resolving a thread, comments, reviews, a merge, a push and a release are written from GitHub's
  documentation and were never sent to GitHub.
  - Comments and reviews are read from the first page only.
  - `gh api` with ETags, rate limits and branch protection moved with CI; see
    [jig-ops](../../jig-ops/docs/not-verified.md).
- **GitLab:** see the section below.
- **What `jig-core` does with a call whose preview throws.** A call with the
  wrong parameters throws from its preview, so the user is not asked about it.
  This assumes `jig-core` blocks such a call and shows the model the message.
  `execute` refuses it either way.
- **The environment `jig-core` gives a program.** `gh` needs its sign-in
  (usually `HOME`). For git calls that reach a remote, `jig-git` passes the ssh
  agent socket, which is a path and not a secret.

## GitLab, not verified

Everything about GitLab was written from its documentation and tested against a fake `glab` that answers from recorded JSON. The
answers have the fields of GitLab's REST API (v4); a merge request was recorded once from a public project, and trimmed.

**What was checked by hand,** with `glab` 1.126 downloaded into a temporary folder and never signed in:
- the `--help` of `glab api`, `glab mr` and `glab release`;
- `glab api -i` against a small local server on 127.0.0.1 with a placeholder token: it prints a status line, the headers, a blank line and
  the body, as `gh` does; a `304` and any status from 300 up exit with 1 and say `glab: HTTP 304` or `glab: 404 Not Found (HTTP 404)`;
  `-X PUT --input -` sends the JSON on standard input as `application/json`; and `--hostname` takes a host name without a port;
- that glab starts `git` in the folder it runs in (`rev-parse --git-dir`, `remote -v`, `config`), with a git wrapper on `PATH`;
- from gitlab.com, with no credentials, for a public project: the list of merge requests and one merge request carry a weak `ETag`,
  answer `304` to `If-None-Match`, and count the `304` against `RateLimit-Remaining`. The notes and the discussions of a merge request
  answered `401` without a sign-in, so their ETags were not seen.

**What is not verified:**
- **The discussions' ETags and the `304` for them.** The poll sends the ETag and reads a `304`, but whether GitLab gives one for
  discussions, and what its `X-Next-Page` is on a `304`, were not seen. The page count of the last full reading stands in for it.
- **`pr review`.** It uses `draft_notes/bulk_publish` with a summary note and `reviewer_state`, as the documentation describes, and has
  not been seen to work with no draft comments pending. The tool reads the notes after the call and says so when the review is not there.
- **Rate limits.** A `429`'s real `Retry-After` and `RateLimit-Reset` values, and the limits of a self-managed server.
- **Merge:** the `409` for a `sha` that no longer matches, the `405` and `422` texts, `auto_merge` and `squash` on a project that requires
  or forbids squashing, and a merge train.
- **The `Draft:` prefix** in its other spellings (`[Draft]`, `(Draft)`, `Draft -`), which `ready` and `edit` read as GitLab does.
- **Labels and reviewers.** `add_labels` creating a label that does not exist, and `reviewer_ids` replacing the list (the tool sends the
  union), as documented.
- **Checks:** the jobs of a pipeline with child pipelines or bridges; only the first 100 jobs of the latest pipeline are read.
- **A sign-in in the keyring,** read over the session bus whose address is passed on, and a host with a port or under a path.
- **Versions.** `auto_merge` was `merge_when_pipeline_succeeds` before GitLab 17.11; a server older than that was not considered.
- **`glab` itself changing.** Nothing here uses its experimental commands (`glab mr note`), only `glab api`.

Back to the [jig-git overview](../README.md).
