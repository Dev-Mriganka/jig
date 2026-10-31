# Actions: notes on single actions

What the tables in the [jig-git overview](../README.md) leave out. Back to the
overview.

## `git`

- **`status`** covers every repository in the workspace when no `repo` is given
  and Pi did not start inside one.
- **`commit`:** an amend without paths only rewords. Message rules come from
  `git.commitMessage` (see [Configuration](configuration.md)).
- **`push`:** the only force is `force_with_lease`, and it is never allowed to a
  protected branch. Tags go through `release`.
- **`rebase` and `cherry_pick`** were built last, because the sessions never
  used them.

## `pr`

On a GitLab project every `pr` action works on merge requests, and a few differ in small ways: a thread is `<number>:<id>`, a draft is a
title prefix, and `merge` with `method: rebase` is refused ([GitLab](gitlab.md)). The notes below are for GitHub unless they say otherwise.

- **`list`** filters by state, author or branch. For the checks themselves, use
  `ci`.
- **`comments`** filters by author or unresolved, and gives full bodies.
- **`create`** returns the existing pull request if the branch has one. Its title
  must match `git.prTitle` when that is set, and so must the title of an `edit`
  (see [Configuration](configuration.md)).
- **`merge`** can also turn on auto-merge.
- **`watch`** starts the background watch on a pull request's comments
  ([Comment watch](comments-watch.md)). It takes a `number`, a `branch` or neither
  (the checked-out branch), and refuses a pull request that is not open.

## `release`

- **`releases`** lists releases, or with a `tag` shows one in full. GitHub marks the latest; GitLab marks an `upcoming` release, one
  dated in the future.
- **`release_create`** takes the notes on standard input and creates the tag from `target` (default: the head of the base branch)
  when it is not on the remote yet; an existing remote tag keeps its commit. `draft`, `prerelease` and `generate_notes` are GitHub's:
  on GitLab each is refused in one line ([GitLab](gitlab.md#what-gitlab-has-no-equivalent-for)).
