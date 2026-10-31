# Conditions

How each of the eight conditions is decided, from what, and what makes a result stop counting. Back to the
[jig-workflow overview](../README.md).

A condition is checked when you ask for `status`, when `advance` runs, and when the gate holds a call. Nothing
is decided from a statement of the agent: each result is made by the plugin, from something it ran, was
shown or was told by a plugin it trusts, and saved against the thing it is about ([State](state.md)).

## Per ticket, and per repository

Some conditions are about the ticket, some about each of its **bound repositories** (the folders in the
ticket's `ticket.json`, see `jig-memory`). A per-repository condition holds only when it holds for all of
them, and fails with "no repository is bound" when there are none. When the gate holds a call in one
repository, only that repository counts.

| Condition | About | Decided from |
|---|---|---|
| `notes-updated` | the ticket | `notes.md` now, against its hash when the stage began |
| `plan-approved` | the ticket | the fingerprint you approved, against `plan.md` now |
| `tests-pass-at-head` | each repository | the last `workflow test` result, against HEAD now |
| `review-done` | each repository | `jig-review:approved` events, against HEAD now |
| `pull-request-open` | each repository | `gh pr view`, or the merge request on GitLab, for the checked-out branch |
| `checks-pass` | each repository | a CI watch result for HEAD, or the checks `gh` or `glab` show |
| `scenarios-pass` | the ticket | the scenario results, against the approved plan's scenarios |
| `you-approve` | the ticket | your answer to the question `advance` asks |

## One by one

- **`notes-updated`.** When a stage begins, the plugin saves the hash of `notes.md`. The condition holds
  when the file differs. It is the cheapest check that the agent wrote down what it learned before moving
  on; it does not judge the notes.
- **`plan-approved`.** Holds when the fingerprint saved by `submit-plan` is the fingerprint of `plan.md`
  now. Any edit, even a comma, ends it. See [Plan](plan.md).
- **`tests-pass-at-head`.** Holds when the last result for the repository passed, on a clean tree, at the
  commit HEAD is now. Uncommitted changes after the run do not undo it, because a push sends commits, not
  the tree; `status` mentions them. See [Tests](tests.md).
- **`review-done`.** `jig-review` publishes `jig-review:approved` when you approve a review, and the plugin
  saves the ones that **cover** commits (a branch review whose diff was still the one you saw) with each
  repository's folder and HEAD. The condition holds when an event names the repository's folder and its
  HEAD now. A review of uncommitted files covers no commit and never counts. An event for another ticket
  is ignored.
- **`pull-request-open`.** `gh pr view --json ...` in the repository, through `jig-core`'s `exec`, so
  `gh` signs in the way you set it up. It holds for a pull request in state `OPEN` for the checked-out
  branch, drafts included. A detached HEAD, a missing `gh` or a host that gh does not know fails with that reason.
  - **On GitLab** the same condition reads the merge request of the branch with `glab api` (`GET
    merge_requests?source_branch=...`, the open one first, else the newest of any state), as `jig-git` reads it, and
    `glab` signs in the way you set it up. A merge request from a fork with the same branch name is not the branch's
    own. `opened` is `OPEN`, and a draft is a flag or a `Draft:` title.
  - **Which forge** is decided from the host of `origin` and the `git.forges` setting of `jig-git`, never by the
    agent: GitHub and `gitlab.com` need nothing, a self-hosted GitLab is named in `git.forges`, and any other host
    stays on `gh`. An ssh alias for a host is mapped there to the real one ([an ssh alias for a real host](../../jig-git/docs/gitlab.md#an-ssh-alias-for-a-real-host)).
- **`checks-pass`.** The pull request's head must be HEAD now ("push first" otherwise). Then either:
  1. a `jig-ops` CI watch ended `passed` for that commit (the event `jig-ops:ci-finished`, with a finish
     line that covers the required checks), which is the precise answer; or
  2. every check in the pull request's roll-up passed, none pending and at least one. This counts optional
     checks too, so a slow optional check keeps it false: start a CI watch for the required checks instead.
  A failed watch for a commit does not stop 2 from holding, since a rerun can pass without a new watch.
  On GitLab the roll-up is the jobs of the merge request's latest pipeline, counted the same way: a job that may fail
  does not fail the pipeline, an unfinished or manual job is pending, and a pipeline made for an older commit counts
  for nothing. A CI watch of the project is matched by its whole path, subgroups included.
- **`scenarios-pass`.** Holds when the plan is approved and each numbered scenario of it has a result of
  `pass` with evidence, recorded for the scenario's current text. See [Plan](plan.md#scenarios).
- **`you-approve`.** `advance` out of a stage that lists it asks you, in a dialog or on a review screen,
  with the evidence of the stage in front of you. The question is asked every time: a rule or an "allow
  for this session" cannot answer it ([Holds](holds.md#calls-that-always-ask)). It holds for that one move.

## What the plugin trusts, and what it checks

- **Events from other plugins** (`jig-review:approved`, `jig-ops:ci-finished`) arrive on Pi's event bus,
  where any extension can publish. The plugin checks each payload's shape, takes only a full 40-digit
  commit, and uses an event only for a repository that is bound. Extensions run with Pi's own rights, so
  this guards against mistakes, not against code you installed. The agent cannot publish on the bus.
- **A pull request's state** is read fresh by `status` and `advance`. The gate uses the last reading while
  HEAD is unchanged, so a hold on `pull-request-open` never waits on the network.
- **A repository that changed under a result** is detected by HEAD. A result is saved with the full commit,
  and "now" is `git rev-parse HEAD` in the repository.

## Reading HEAD

Every per-repository check starts from the repository's HEAD, its checked-out branch and whether its tree
is clean, read with `jig-core`'s `exec.git`, which runs with hooks off and refuses a repository whose
configuration would run a command. A repository that is not a work tree, or has no commit yet, fails
with that reason.

[Back to the overview](../README.md)
