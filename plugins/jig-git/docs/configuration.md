# Configuration: the `git` section

The fields of the `git` section of `jig.json`, in detail. The table is in the
[jig-git overview](../README.md#configure). Back to the overview.

- **`base`:** the branch new work starts from and pull requests target. The
  default is the repository's default branch.
- **`protected`:** a list where `*` matches any characters. A protected branch
  refuses a direct push, a force push, a rebase, a cherry-pick, and being
  created or deleted by these tools. Setting it replaces the default.
- **`commitMessage` and `branchName`:** regular expressions. A commit message is
  tested whole, so anchor it with `^`.
- **`prTemplate`:** the path of a Markdown file, absolute or relative to the
  repository.
- **`cloneHost`:** the only host other than `github.com` that a clone request
  may name. The URL git receives is built from it; the model never names a host.

## Moved fields

`git.watch` and `git.artifacts` moved to `ops.watch` and `ops.artifacts` with
the CI watch. `jig-core` reports them with where they are now.
