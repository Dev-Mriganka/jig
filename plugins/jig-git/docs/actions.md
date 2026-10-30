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

- **`list`** filters by state, author or branch. For the checks themselves, use
  `ci`.
- **`comments`** filters by author or unresolved, and gives full bodies.
- **`create`** returns the existing pull request if the branch has one. Its title
  must match `git.prTitle` when that is set, and so must the title of an `edit`
  (see [Configuration](configuration.md)).
- **`merge`** can also turn on auto-merge.
