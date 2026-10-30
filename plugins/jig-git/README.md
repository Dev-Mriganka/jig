# jig-git: git, GitHub and CI

**Status: built.** This README is the specification, and the code follows it.
The tests run against temporary repositories and recorded GitHub answers.
Nothing has been tried against GitHub itself yet (see "Not verified yet").

`jig-git` gives the agent four tools:
- `git`: the local repository;
- `pr`: GitHub pull requests and reviews;
- `checks`: GitHub checks and Actions, and watching them in the background;
- `release`: tags and releases.

The watches run on `jig-core`'s watch engine, and `jig-core`'s `watch` tool
lists and stops them.

Every tool declares the environment and effect of each action to `jig-core`.
Reads and local writes are allowed; writes to GitHub ask you.

The tool list comes from two sources:
- an inventory of two months of real sessions: about 26,000 tool calls, plus
  about 3,800 `git` and 200 `gh` commands run through `bash`;
- standard developer needs.

## What the sessions showed

- **Most of `git` and `pr` already exists** in the existing harness, which has
  run about 225 of these calls. It is ported, not redesigned.
- **What was missing is the wait.** Nothing watched GitHub CI, so you were the
  signal: about 15 "is it done?" nudges in one month. One build was ready 7
  minutes after the push and reached the agent 2 hours 16 minutes later.
- **"All checks done" is the wrong finish line.** Six background
  `gh pr checks --watch` runs never finished. In one pull request, two of ten
  checks were still pending 20 hours after the build the next step needed had
  passed.
- **The agent stops using `bash` for a job once a tool covers it.** `gh` calls
  through `bash` fell from 148 to 3 after the `pr` tool arrived.

## Tools

Default decisions:
- **read:** allowed;
- **local write:** allowed;
- **external write:** asks.

A rule in your configuration can change any of them, within the floor.

**Which repository.** Every action takes an optional `repo`: a folder name in
the workspace, or an absolute path inside a work tree. The workspace is the
folder Pi started in. When Pi started inside a repository, the workspace is the
folder that holds it. Without `repo`, a call means the repository Pi started
in.

### `git`: the local repository

| Action | What it does | Default |
|---|---|---|
| `status` | Branch, upstream, ahead and behind the base, changed files. Every repository in the workspace when no `repo` is given and Pi did not start inside one | read |
| `diff` | Working tree, staged, a range `a..b`, or against the merge base; limited to paths; as a summary, file names or a patch | read |
| `log` | A range or paths, filtered by author, date or message, in a chosen format | read |
| `show` | A commit, or a file at a revision | read |
| `blame` | Who last changed each line | read |
| `branches` | Local and remote branches, their tracking, and which contain a commit | read |
| `fetch` | Branches and tags from the remote | read |
| `clone` | `owner/name` into a new folder of the workspace, over SSH only | local write |
| `branch` | Create from the fetched base, switch, or delete a merged branch | local write |
| `worktree` | List, add or remove worktrees | read; adding and removing are local writes |
| `commit` | Exact paths and a message. Amend only while no remote has the commit; amend without paths only rewords it. Message rules come from configuration | local write |
| `stash` | Push, list, pop, drop | local write |
| `sync` | Fast-forward from the upstream | local write |
| `merge` | Merge the base or another branch; a conflict aborts cleanly | local write |
| `rebase`, `cherry_pick` | A conflict aborts cleanly; a checked-out protected branch is refused. Built last: the sessions never used them | local write |
| `restore` | Discard changes in the listed paths | local write, but **asks** by default: it destroys uncommitted work |
| `push` | A branch. The preview lists the commits. Force only with lease, never to a protected branch. Tags go through `release` | external write |

### `pr`: pull requests and reviews

| Action | What it does | Default |
|---|---|---|
| `view`, `list` | State, draft, mergeable, review decision, checks and body; a list by state, author or branch | read |
| `comments` | The conversation, reviews and line comments, with full bodies and thread ids; filter by author or unresolved | read |
| `create` | A pull request from a pushed branch. Without a body it shows the body template to fill in. Returns the existing one if there is one | external write, on the review screen |
| `edit` | Title, body, base, labels, reviewers | external write; the new text goes on the review screen |
| `ready` | Draft to ready | external write |
| `comment`, `reply`, `resolve` | A comment, a reply in a review thread, resolving a thread | external write; text goes on the review screen |
| `review` | Comment, or request changes. **Never approve:** approval stays human | external write; text goes on the review screen |
| `merge` | Merge, squash or rebase, only while the head is still the commit you saw; or turn on auto-merge | external write |

### `checks`: GitHub checks and Actions

| Action | What it does | Default |
|---|---|---|
| `status` | The checks of a pull request, branch or commit; only the required ones if asked (`required_only`) | read |
| `runs`, `run`, `artifacts` | Workflow runs by branch, commit or state; one run's jobs and steps; its artifacts | read |
| `log` | A failed job's log: the tail, or the lines matching a search; capped at 400 lines and redacted | read |
| `rerun` | The failed jobs, or the whole run | external write |
| `watch` | Starts a background watch on a pull request, branch, run, tag or release, with a finish line. Returns its id at once | local write |

`checks` covers GitHub only. Other CI systems belong in a company plugin (see
[Plugins](../../docs/plugins.md)).

### `release`: tags and releases

| Action | What it does | Default |
|---|---|---|
| `tags`, `releases` | Tags (the latest matching a pattern, or those containing a commit); releases, listed or one in full | read |
| `tag_create` | An annotated tag, locally | local write |
| `tag_push` | Push a tag | external write |
| `release_create` | A GitHub release | external write |

The sessions barely used tags and releases (one `git tag`, no `gh release`),
so these actions rest on standard practice.

### Left out on purpose

| Not offered | Why |
|---|---|
| Starting a workflow by hand | A workflow can deploy; deploys belong to a deploy tool with its own rules |
| A raw GitHub API tool | Its writes cannot be classified |
| Approving a pull request | Approval stays human |
| Deleting tags, `reset --hard`, `clean` | They destroy work and are rarely needed; you can run them yourself |

`git`, `pr` and `checks` are always loaded, and so is `jig-core`'s `watch`.
In the sessions, a "tool not found" cost the agent extra calls.

### What you see before a write asks

| Action | The preview |
|---|---|
| `git push` | The branch, the remote, the head commit and the commits to send |
| `git restore` | The paths, and a diff stat of what would be lost |
| `pr create`, `edit`, `comment`, `reply`, `review` | The text, rendered, on the review screen |
| `pr merge` | The title, the method and the head commit |
| `checks rerun` | The run, and whether all jobs or only the failed ones run again |
| `release` `tag_push`, `release_create` | The tag and what it points at, and the notes |

Each preview carries a digest of what it shows. When the call runs, the tool
works out what it would do now. If the digest differs, it refuses with
"changed since the preview; run it again to see the new preview". A new
commit, or a pull request head that moved while you read, is caught this way.
A call that did not ask has no preview to compare.

A call with the wrong parameters is refused with the usage line before it asks
anything.

### When a reply is lost

A write to GitHub can time out, lose its connection, get a gateway error, or be
cancelled with Esc after the request left. Then the tool:
- reads GitHub once, to see whether the change is there;
- reports what it found, and that the reply was lost;
- never sends the request again.

The one read is `pr list` for a new pull request, `pr view` for an edit, a
merge, a draft or a review, the thread itself for a reply or a resolve,
`ls-remote` for a push or a tag, the run's attempt number for a rerun, and
`release view` for a release.

## Watching CI until it is done

A watch runs on `jig-core`'s watch engine, outside the sandbox, and the call
that starts it returns at once. `jig-git` supplies what to poll on GitHub and
when the watch is done.

![A push or checks watch starts a watch that polls GitHub until a finish line is reached; one message wakes the agent, and an artifact-ready event may lead a company plugin to deploy, only through jig-core](../../docs/img/ci-watch.svg)

*From a push to a wake-up: the watch polls GitHub until its finish line, one message starts the agent's turn, and an artifact-ready event may lead a company plugin to deploy, but only through `ctx.executeTool`, so `jig-core` still asks for a test environment unless a rule allows it, and denies production.*

1. **It starts by itself** after `git push` and `pr create` (setting
   `watch.auto`), or when the agent calls `checks watch`. A newer push to the
   same branch replaces the watch of the older commit. Its title says what it
   watches, such as "checks of pull request 42" or "checks of branch x at
   abc1234".
2. **Its finish line is explicit, never "all checks".** It can be:
   - the required checks;
   - a named check, such as the job that builds the image;
   - one run;
   - a pull request state, such as approved or merged;
   - a bot comment matching a pattern;
   - a tag or release matching a pattern.

   It stops at the first required failure. It sends a "still waiting" notice
   after 30 minutes and gives up after 60.
3. **It polls GitHub's API every 30 seconds, with ETags.** An unchanged answer
   (`304`) does not count against GitHub's rate limit, and the watch follows
   GitHub's `X-Poll-Interval` when GitHub sends one. A lost login gives one
   notice and pauses the watch; it never blocks a call.
4. **It sends one message per result, and the message starts a turn of the
   agent.**
   - When the watch passes: counts and the commit.
   - When it fails: the failing checks, their links, and the lines around the
     first error in the failed job's log.

   Notices are combined when they arrive together, sent at least 10 seconds
   apart, and only one waits at a time.
5. **Open watches survive a restart.** They are saved in the state folder and
   resume when Pi starts. A result found by the first poll after a restart
   begins "While Pi was closed: ".

### What each finish line means

| Finish | The watch ends when |
|---|---|
| Required checks (the default) | Every required check passed, or at the first required failure. A required check that no one has reported yet is pending |
| A named check | That check ends. Passed is a pass. Failed, cancelled, timed out or skipped is a failure: a skipped check will never run |
| One run | The run completes, or one of its jobs fails |
| A pull request state | Approved: someone approved and nobody asks for changes. Merged: the pull request is merged. Either way, a pull request closed without a merge is a failure, and a request for changes while waiting for approval is a failure |
| A bot comment | A comment made after the watch began matches the pattern. By the named login, else by any bot |
| A tag or release | A tag or release that did not exist when the watch began matches the pattern, or a tag on the watched commit does |

The required checks come from the protection and the rulesets of the pull
request's base branch, or of the default branch when there is no pull request.
When neither names a check, every check counts. A pull request that gets a
newer commit ends the watch of the older one as stopped.

### Knowing that a build or a tag exists

Rules in configuration say when an artifact is ready. They are tested when a
watch has passed:
- a named job succeeded for the head commit;
- a version is read from that job's log, by a pattern, and it contains the
  head's short commit id;
- a bot comment on the pull request matches a pattern;
- a tag or release matches a pattern, and it is on the head commit or carries
  its short id.

A version that does not contain the watched commit is ignored. A rule that
cannot be tested (the log has expired, say) does not lose the watch's result:
the message says so.

### Events

On Pi's event bus, for other plugins:
- `jig:watch-done`, from `jig-core`'s engine: a watch finished, with its
  result;
- `jig-git:artifact-ready`: `{ repo, pr, sha, kind: image | tag | release, ref, source: check | log | comment | tag | release }`.
  `ref` is the version, tag or release tag. For a rule with a job and no log
  pattern, it is the short commit id.

### `jig-git` never deploys

What happens after "artifact ready" is a company decision. A company plugin may
listen for the event, and it always tells the agent. It may start a deploy by
itself only when all of these hold:
- its automatic deploy setting is on (off by default);
- the watch was started for a deploy you asked for;
- the target is the first shared test environment, and the deploy replaces no
  one else's build there.

The deploy goes through `ctx.executeTool`, so `jig-core` still decides:
- a write to a test environment asks, unless your rule allows it;
- production is denied.

Automation stops wherever a person must approve, such as a pull request that
needs a code owner.

## Ported from the existing harness

- **A table of parameters per action,** with errors that show the correct
  usage.
- **A hardened git runner,** now `jig-core`'s `exec.git`, which every git call
  goes through. git runs from an argument list, never a shell, with hooks,
  `core.fsmonitor` and prompts switched off. Before it runs in a repository, it
  refuses `.git/config` settings that would run a command, such as
  `credential.helper`, `diff.external`, `gpg.program` or `include.path`. The
  agent's shell can write that file, and the tool runs outside the sandbox with
  your credentials. Every `gh` call goes through `jig-core`'s `exec.run`.
- **Preview, then run.** A write shows what it will do, and refuses if anything
  changed since the preview.
- **A lost reply is checked with one read, never retried.**
- **A closed grammar for what `clone` accepts.** `owner/name`, or an ssh or
  https URL of `github.com` or the clone host. The URL git receives is built
  from `cloneHost`; the model never names a host or a transport. git clones
  into a temporary folder and renames it into place only when it finished.
- **Check states mapped to pass, fail, pending and skipped.**
- **Pull request comments assembled with their line comments and threads.**

## Configure

In `~/.pi/agent/jig.json`, under `git`. All fields are optional; a company
plugin can set them for its repositories. `jig-core` reports an unknown or
invalid field, and the defaults apply instead.

| Field | Default | Meaning |
|---|---|---|
| `base` | the repository's default branch | The branch new work starts from and pull requests target |
| `protected` | the repository's default branch | Branches that refuse a direct push, a force push, a rebase and a cherry-pick. A list where `*` matches any characters. Setting it replaces the default |
| `commitMessage`, `branchName` | none | Regular expressions that commit messages and new branch names must match. A message is tested whole, so anchor with `^` |
| `prTemplate` | the repository's own template | The pull request body template: the path of a Markdown file, absolute or relative to the repository |
| `cloneHost` | `github.com` | The ssh host `clone` connects to: `github.com`, or a `Host` alias from `~/.ssh/config`. The only host other than `github.com` that a clone request may name |
| `watch.auto` | `true` | Start a watch after `git push` and `pr create` |
| `watch.pollSeconds`, `watch.stallMinutes`, `watch.timeoutMinutes` | 30, 30, 60 | Polling and limits |
| `artifacts` | none | The "artifact ready" rules. Each has a `kind` (`image`, `tag` or `release`) and one place to look: `check` (a job name, with an optional `log` pattern), `comment` (a pattern, with an optional `bot` login), or `tag` (a name pattern) |

## Not in this plugin

- **Other CI systems** (for example Concourse or Jenkins), deploy tools and
  container registry checks. They belong in a company plugin.
- **Gates on commit and push,** such as "no push without a review". They are
  `jig-flow` rules, not git code.
- **A company's conventions,** such as branch names, protected branches and the
  pull request template. They are the settings above, set by the company
  plugin.

## Not verified yet

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

## Layout

```text
jig-git/
  src/
    index.ts                      the plugin: the tools, and through withJig their declarations, the git section and the watch kind
    git.ts pr.ts checks.ts release.ts    the four tools: schema, table of actions, classification
    git-read.ts git-local.ts git-remote.ts clone.ts    the git actions
    pr-read.ts pr-write.ts        the pull request actions
    checks-read.ts                the checks actions that only read
    github.ts                     gh: argument lists, JSON, gh api with ETags, lost replies
    repo.ts                       which repository, the workspace, the remote, the default branch
    watch.ts artifacts.ts autowatch.ts   the GitHub watch kind, the artifact rules, the watch after a push
    ci.ts logs.ts                 check states, job logs
    config.ts previews.ts tool.ts params.ts names.ts text.ts run.ts   settings, plan and preview, the tool builder, checks on input
  skills/   git/SKILL.md: how to use the tools (status before commit, watch after push)
  test/     against temporary local repositories, a fake gh and a fake jig-core
```
