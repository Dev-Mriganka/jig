# Configuration: the `git` section

The fields of the `git` section of `jig.json`, in detail. The table is in the
[jig-git overview](../README.md#configure). Back to the overview.

- **`base`:** the branch new work starts from and pull requests target. The
  default is the repository's default branch.
- **`protected`:** a list where `*` matches any characters. A protected branch
  refuses a direct push, a force push, a rebase, a cherry-pick, and being
  created or deleted by these tools. Setting it replaces the default.
- **`commitMessage`, `branchName` and `prTitle`:** regular expressions. A commit
  message is tested whole, so anchor it with `^`.
  - **`prTitle`** is the same rule for a pull request's title. `pr create` and
    `pr edit` (when it sets a title) check it while the preview is built, so a title
    that does not match is refused before anyone is asked and before anything is
    sent. The message shows the pattern, as in `git.prTitle (^PROJ-\d+: )`. An
    `edit` that leaves the title alone is not checked. On GitLab it is checked
    against the title as written, before the `Draft: ` prefix of a draft is added.
- **`prTemplate`:** the path of a Markdown file, absolute or relative to the
  repository.
- **`cloneHost`:** the only host other than `github.com` that a clone request
  may name. The URL git receives is built from it; the model never names a host.
- **`watchComments`:** `"after-create"` (the default) or `"off"`. With
  `"after-create"`, `pr create` starts a watch on the comments of the new pull
  request. `pr watch` works either way ([Comment watch](comments-watch.md)).
- **`watchBots`:** `true` or `false` (the default). Whether the comment watch also
  tells the agent about comments made by bots. It is read at each poll, so a
  change applies to a watch that is already running.
- **`forges`:** an object of host names. It names the hosts that are not `github.com` or `gitlab.com`, and each entry is a forge,
  `"github"` or `"gitlab"`, such as `{ "gitlab.example.com": "gitlab" }`, or an object `{ "forge": "github", "host": "github.com" }`
  for an ssh alias of a real host. Host names are compared without regard to case, and carry no port. An `origin` on any other
  host is refused. The setting is configuration only: no call can set or change it
  ([GitLab](gitlab.md#which-forge-a-repository-is-on)).
  - **A word** is the forge, and `gh` or `glab` is told the host in `origin`.
  - **An object** names the forge and, with `host`, the real host `gh` and `glab` are told. git goes on using the alias in
    `origin`, so cloning, fetching and pushing are unchanged ([an ssh alias](gitlab.md#an-ssh-alias-for-a-real-host)).

## Moved fields

`git.watch` and `git.artifacts` moved to `ops.watch` and `ops.artifacts` with
the CI watch. `jig-core` reports them with where they are now.
