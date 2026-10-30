# jig-git: git, GitHub and CI

**Status: built.** Tested against temporary repositories and recorded GitHub
answers. Nothing has been tried against GitHub itself yet (see
[Not verified yet](docs/not-verified.md)).

`jig-git` gives the agent four tools: `git` for the local repository, `pr` for
GitHub pull requests and reviews, `checks` for GitHub checks and Actions, and
`release` for tags and releases. For example, after `git push` the tool starts a
watch on the pushed commit's required checks; the agent goes on with other work,
and one message wakes it when they pass or the first required one fails. The
watches run on `jig-core`'s watch engine, and its `watch` tool lists and stops
them. `checks` covers GitHub only; other CI systems belong in a company plugin
(see [Plugins](../../docs/plugins.md)).

![A push or checks watch starts a watch that polls GitHub until a finish line is reached; one message wakes the agent, and an artifact-ready event may lead a company plugin to deploy, only through jig-core](../../docs/img/ci-watch.svg)

*From a push to a wake-up: the watch polls GitHub until its finish line, one message starts the agent's turn, and an artifact-ready event may lead a company plugin to deploy, but only through `ctx.executeTool`, so `jig-core` still asks for a test environment unless a rule allows it, and denies production.*

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
| `view`, `list` | read | State, draft, mergeable, review decision, checks and body; a list by state, author or branch |
| `comments` | read | The conversation, reviews and line comments, with full bodies and thread ids; filter by author or unresolved |
| `create` | external write, asks on the review screen | A pull request from a pushed branch. Without a body it shows the body template to fill in. Returns the existing one if there is one |
| `edit` | external write, asks on the review screen | Title, body, base, labels, reviewers. The new text goes on the review screen |
| `ready` | external write, asks | Draft to ready |
| `comment`, `reply` | external write, asks on the review screen | A comment, or a reply in a review thread |
| `resolve` | external write, asks | Resolves a review thread |
| `review` | external write, asks on the review screen | Comment, or request changes. **Never approve:** approval stays human |
| `merge` | external write, asks | Merge, squash or rebase, only while the head is still the commit you saw; or turn on auto-merge |

## Tool: `checks`

| Action | Kind | What it does |
|---|---|---|
| `status` | read | The checks of a pull request, branch or commit; only the required ones if asked (`required_only`) |
| `runs`, `run`, `artifacts` | read | Workflow runs by branch, commit or state; one run's jobs and steps; its artifacts |
| `log` | read | A failed job's log: the tail, or the lines matching a search; capped at 400 lines and redacted |
| `rerun` | external write, asks | The failed jobs, or the whole run |
| `watch` | local write | Starts a background watch on a pull request, branch, run, tag or release, with a finish line. Returns its id at once |

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
- **A watch has an explicit finish line,** never "all checks". It starts by
  itself after `git push` and `pr create`, and one message wakes the agent when
  it ends.
- **`jig-git` never deploys.** It announces "artifact ready"; a company plugin
  decides what follows, and any deploy still goes through `jig-core`.

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
| `watch.auto` | `true` | Start a watch after `git push` and `pr create` |
| `watch.pollSeconds`, `watch.stallMinutes`, `watch.timeoutMinutes` | 30, 30, 60 | Polling every 5 to 3600 seconds; a "still waiting" notice after 1 to 1440 minutes; giving up after 1 to 1440 minutes |
| `artifacts` | none | The "artifact ready" rules. Each has a `kind` (`image`, `tag` or `release`) and one place to look: `check` (a job name, with an optional `log` pattern), `comment` (a pattern, with an optional `bot` login), or `tag` (a name pattern) |

```json
{
  "git": {
    "base": "main",
    "protected": ["main", "release/*"],
    "branchName": "^(feature|fix)/PROJ-\\d+",
    "commitMessage": "^PROJ-\\d+: ",
    "artifacts": [
      { "kind": "image", "check": "build-image", "log": "image: (\\S+)" }
    ]
  }
}
```

## Company part (in the company plugin)

- the `git` settings for its repositories: base and protected branches, branch
  and commit message patterns, the pull request template, the clone host;
- the "artifact ready" rules, and what follows them, such as a deploy to
  `staging`, within the policy for automatic deploys;
- other CI systems and deploy tools.

## Layout

```text
jig-git/
  src/
    index.ts                              the plugin: the tools, their declarations, the git section, the watch kind
    git.ts, pr.ts, checks.ts, release.ts  the four tools: schema, table of actions, classification
    git-read.ts, git-local.ts, git-remote.ts, clone.ts   the git actions
    pr-read.ts, pr-write.ts, checks-read.ts              the pull request actions, and the checks that only read
    github.ts, repo.ts, ci.ts, logs.ts    gh (argument lists, JSON, ETags, lost replies); which repository; check states; job logs
    watch.ts, artifacts.ts, autowatch.ts  the GitHub watch kind, the artifact rules, the watch after a push
    config.ts, previews.ts, tool.ts, params.ts, names.ts, text.ts, run.ts   settings, plan and preview, tool builder, input checks
  skills/   git/SKILL.md: how to use the tools (status before commit, watch after push)
  test/     against temporary local repositories, a fake gh and a fake jig-core
  docs/     the detail pages below
```

## More detail

- [Watching CI](docs/watching-ci.md): the watch, its finish lines, polling, events
- [Artifacts and deploys](docs/artifacts-and-deploys.md): "artifact ready", and
  why `jig-git` never deploys
- [Writes](docs/writes.md): what you see before a write asks, and lost replies
- [Scope](docs/scope.md): what is left out on purpose, and what belongs elsewhere
- [Background](docs/background.md): the sessions the tool list comes from, and
  what was ported
- [Not verified yet](docs/not-verified.md): what the tests do not cover
