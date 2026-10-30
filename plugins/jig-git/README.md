# jig-git: git, pull requests and releases

**Status: built.** Tested against temporary repositories and recorded GitHub
answers. Nothing has been tried against GitHub itself yet (see
[Not verified yet](docs/not-verified.md)).

`jig-git` gives the agent three tools: `git` for the local repository, `pr` for
GitHub pull requests and reviews, and `release` for tags and releases. For
example, "commit these two files, push, and open a pull request": `git commit`
takes exact paths, `git push` shows the commits it will send and waits for you,
and `pr create` shows the body on a review screen. CI is not here: checks, runs,
logs and watches are the `ci` tool of [`jig-ops`](../jig-ops/README.md). The two
meet in one event: after a push and after a new pull request, `jig-git`
announces `jig-git:pushed`, and `jig-ops` starts a watch if it knows the
repository (see [Events](#events)).

## Tool: `git`

| Action | Kind | What it does |
|---|---|---|
| `status` | read | Branch, upstream, ahead and behind the base, changed files. Every repository in the workspace when no `repo` is given and Pi did not start inside one |
| `diff` | read | Working tree, staged, a range `a..b`, or against the merge base; limited to paths; as a summary, file names or a patch |
| `log` | read | A range or paths, filtered by author, date or message, in a chosen format |
| `show` | read | A commit, or a file at a revision |
| `blame` | read | Who last changed each line |
| `branches` | read | Local and remote branches, their tracking, and which contain a commit |
| `fetch` | read | Branches and tags from the remote |
| `clone` | local write | `owner/name` into a new folder of the workspace, over SSH only |
| `branch` | local write | Create from the fetched base, switch, or delete a merged branch |
| `worktree` | read; adding and removing are local writes | List, add or remove worktrees |
| `commit` | local write | Exact paths and a message. Amend only while no remote has the commit; amend without paths only rewords it. Message rules come from configuration |
| `stash` | local write | Push, list, pop, drop |
| `sync` | local write | Fast-forward from the upstream |
| `merge` | local write | Merge the base or another branch; a conflict aborts cleanly |
| `rebase`, `cherry_pick` | local write | A conflict aborts cleanly; a checked-out protected branch is refused. Built last: the sessions never used them |
| `restore` | local write, asks | Discard changes in the listed paths. It asks by default because it destroys uncommitted work |
| `push` | external write, asks | A branch. The preview lists the commits. Force only with lease, never to a protected branch. Tags go through `release` |

## Tool: `pr`

| Action | Kind | What it does |
|---|---|---|
| `view`, `list` | read | State, draft, mergeable, review decision, a one-line roll-up of the checks, and body; a list by state, author or branch. For the checks themselves, use `ci` |
| `comments` | read | The conversation, reviews and line comments, with full bodies and thread ids; filter by author or unresolved |
| `create` | external write, asks on the review screen | A pull request from a pushed branch. Without a body it shows the body template to fill in. Returns the existing one if there is one |
| `edit` | external write, asks on the review screen | Title, body, base, labels, reviewers. The new text goes on the review screen |
| `ready` | external write, asks | Draft to ready |
| `comment`, `reply` | external write, asks on the review screen | A comment, or a reply in a review thread |
| `resolve` | external write, asks | Resolves a review thread |
| `review` | external write, asks on the review screen | Comment, or request changes. **Never approve:** approval stays human |
| `merge` | external write, asks | Merge, squash or rebase, only while the head is still the commit you saw; or turn on auto-merge |

## Tool: `release`

| Action | Kind | What it does |
|---|---|---|
| `tags`, `releases` | read | Tags (the latest matching a pattern, or those containing a commit); releases, listed or one in full |
| `tag_create` | local write | An annotated tag, locally |
| `tag_push` | external write, asks | Push a tag |
| `release_create` | external write, asks | A GitHub release |

## Rules

- **Reads and local writes run; writes to GitHub ask you.** Every tool declares
  the environment and effect of each action to `jig-core`, and a rule in your
  configuration can change any default, within the floor.
- **Which repository.** Every action takes an optional `repo`: a folder name in
  the workspace, or an absolute path inside a work tree. The workspace is the
  folder Pi started in; when Pi started inside a repository, it is the folder
  that holds it. Without `repo`, a call means the repository Pi started in.
- **Writes are previewed, and never repeated blindly.** A write that asks shows
  what it will do, and refuses if anything changed since. If a reply is lost,
  the tool reads GitHub once and reports what it found; it never sends the
  request again. A call with the wrong parameters is refused with the usage line
  before it asks anything.
- **A push is announced, and nothing more.** After `git push` and `pr create`
  the plugin publishes `jig-git:pushed` and goes on. It watches no CI, reads no
  catalog and starts no watch: that is `jig-ops`, if it is installed.
- **`jig-git` never deploys,** and never starts a workflow. Deploys have their
  own tool and their own rules.

## Configure

In `~/.pi/agent/jig.json`, under `git`. All fields are optional; a company
plugin can set them for its repositories. `jig-core` reports an unknown or
invalid field, and the defaults apply instead.

| Field | Default | Meaning |
|---|---|---|
| `base` | the repository's default branch | The branch new work starts from and pull requests target |
| `protected` | the repository's default branch | Branches that refuse a direct push, a force push, a rebase, a cherry-pick, and being created or deleted by these tools. A list where `*` matches any characters. Setting it replaces the default |
| `commitMessage`, `branchName` | none | Regular expressions that commit messages and new branch names must match. A message is tested whole, so anchor with `^` |
| `prTemplate` | the repository's own template | The pull request body template: the path of a Markdown file, absolute or relative to the repository |
| `cloneHost` | `github.com` | The ssh host `clone` connects to: `github.com`, or a `Host` alias from `~/.ssh/config`. The only host other than `github.com` that a clone request may name |

```json
{
  "git": {
    "base": "main",
    "protected": ["main", "release/*"],
    "branchName": "^(feature|fix)/PROJ-\\d+",
    "commitMessage": "^PROJ-\\d+: "
  }
}
```

`git.watch` and `git.artifacts` moved to `ops.watch` and `ops.artifacts` with the
watch. `jig-core` reports them with where they are now.

## Company part (in the company plugin)

- the `git` settings for its repositories: base and protected branches, branch
  and commit message patterns, the pull request template, the clone host;
- later, the sign-in for a git host that is not `github.com`.

## Events

On Pi's event bus, for other plugins:

- **`jig-git:pushed`,** published after a push has landed and after a pull
  request is created: `{ repo, branch, sha, pr? }`. `repo` is `owner/name` as
  origin names it, `sha` is the full id of the pushed head, and `pr` is the open
  pull request of the branch, when there is one. Nothing is published when
  origin is not on GitHub. `jig-ops` listens and starts a CI watch for a service
  of its catalog that has this repository. A listener that fails never undoes the
  push.

## Layout

```text
jig-git/
  src/
    index.ts                              the plugin: the tools, their declarations, the git section, the event bus
    git.ts, pr.ts, release.ts             the three tools: schema, table of actions, classification
    git-read.ts, git-local.ts, git-remote.ts, clone.ts   the git actions
    pr-read.ts, pr-write.ts               the pull request actions
    github.ts, repo.ts, ci.ts, events.ts  gh (argument lists, JSON, lost replies); which repository; the check roll-up; jig-git:pushed
    config.ts, previews.ts, tool.ts, params.ts, names.ts, text.ts, run.ts   settings, plan and preview, tool builder, input checks
  skills/   git/SKILL.md: how to use the tools (status before commit, what a push announces)
  test/     against temporary local repositories, a fake gh and a fake jig-core
  docs/     the detail pages below
```

## More detail

- [Events](docs/events.md): `jig-git:pushed`, who publishes it, and what a listener can rely on
- [Writes](docs/writes.md): what you see before a write asks, and lost replies
- [Scope](docs/scope.md): what is left out on purpose, and what belongs elsewhere
- [Background](docs/background.md): the sessions the tool list comes from, and
  what was ported
- [Not verified yet](docs/not-verified.md): what the tests do not cover
