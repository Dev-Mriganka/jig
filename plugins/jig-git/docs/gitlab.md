# GitLab: merge requests and releases through glab

How `pr` and `release` work on a GitLab project, so a team on GitLab uses the same tools as a team on GitHub. Back to the
[jig-git overview](../README.md).

The tools, the actions and their names are the same. The repository decides which forge a call goes to, never the model. On GitLab a
pull request is a merge request, and the tools talk to GitLab through `glab`, as they talk to GitHub through `gh`.

## Which forge a repository is on

The host of `origin` decides. The model cannot choose it, so a call cannot send one forge's request with another forge's sign-in.

| Host of origin | Forge |
|---|---|
| `github.com`, `ssh.github.com`, `github.com-<alias>` or `git.cloneHost` | GitHub, through `gh` |
| `gitlab.com` or `altssh.gitlab.com` | GitLab, through `glab`, on `gitlab.com` |
| A host named in `git.forges` | What the setting says |
| No host (a local path, or no origin) | GitHub, as before: `gh` reads the repository's own remotes |
| Any other host | `pr` and `release` refuse it, with the line that names it |

```json
{ "git": { "forges": { "gitlab.example.com": "gitlab" } } }
```

- **The refusal for an unknown host** says which host it was and shows the setting that names it, as in `origin of orders-api is on
  git.example.com, which jig-git does not know as GitHub or GitLab; name it in jig.json, such as "git": { "forges": {
  "git.example.com": "gitlab" } }`.
- **A host set to `"github"`** is accepted as GitHub, which is how a GitHub Enterprise Server host is told apart from the refused
  ones. `gh` then finds the repository from the remotes, as it did before any host was refused.
- **Nested groups** work: `platform/payments/orders-api` is a project path of three parts, and `origin` may use https, ssh or scp
  form. The host is the one `origin` names, so an ssh alias from `~/.ssh/config` is not a GitLab host: use the real name.

## Sign-in

`glab` owns it. Run `glab auth login --hostname gitlab.example.com` yourself; Jig never signs in, never reads a token and never
writes one. `glab` keeps its sign-in in `~/.config/glab-cli`, which `jig-core` protects from the agent's file tools and the sandbox
by default, next to `~/.config/gh`.

A call that finds `glab` not signed in says so in one line, with the command to run. `GITLAB_TOKEN` and the like are not passed to
`glab`: jig-core gives a program a short list of variables, and a token in the environment is not on it.

## How a call runs

Every request is `glab api --hostname <host> <endpoint>` on GitLab's REST API (v4), with the project's path encoded in the address
and a JSON body on standard input. A request says exactly what it does, so a preview can promise it.

glab's own commands (`glab mr merge`, `glab mr create`) prompt and choose for themselves, such as turning on auto-merge while a
pipeline runs, so none of them is used.

- **glab runs in the repository.** It starts git there and reads its configuration. `jig-core` vets a repository for `git` and `gh`;
  it does not know `glab`, so each glab call is preceded by a harmless git call through `jig-core`, which refuses a repository whose
  own configuration would run a command.
- **glab is told not to prompt,** check for updates, send usage data, page or colour its output.
- **A sign-in kept in the keyring** is read over the session bus, whose address is passed on (it is a path, not a secret).

## What each action does

| `pr` action | What is sent to GitLab |
|---|---|
| `view` | The merge request, and the jobs of its latest pipeline for the checks roll-up |
| `list` | Merge requests by state, author or source branch; `@me` is `scope=created_by_me` |
| `comments` | The discussions: threads with their notes, and single comments; system notes are left out |
| `create` | `POST merge_requests`; a draft is a title with the prefix `Draft: ` |
| `edit` | `PUT merge_requests/:iid`; labels are added; reviewers are looked up by username and added |
| `ready` | `PUT merge_requests/:iid` with the `Draft: ` prefix taken off the title |
| `comment` | `POST merge_requests/:iid/notes` |
| `reply` | `POST merge_requests/:iid/discussions/:id/notes` |
| `resolve` | `PUT merge_requests/:iid/discussions/:id` with `resolved: true` |
| `review` | `POST …/draft_notes/bulk_publish` with the text and the state `reviewed` or `requested_changes` |
| `merge` | `PUT merge_requests/:iid/merge` with `sha` (the head you saw), `squash`, and `auto_merge` for `auto` |
| `watch` | A background poll of the merge request and its discussions ([Comment watch](comments-watch.md)) |

| `release` action | What is sent to GitLab |
|---|---|
| `releases` | `GET releases`, or `GET releases/:tag` for one in full |
| `release_create` | `POST releases` with the tag, title and notes, and `ref` when the tag does not exist yet |

`tags`, `tag_create` and `tag_push` are git and do not change.

## What GitLab has no equivalent for

Each is refused in one line, before anyone is asked, with the GitLab way.

| Call | Why, and what to do |
|---|---|
| `pr merge` with `method: rebase` | GitLab rebases through the project's merge method; run `glab mr rebase <n>` yourself, then merge |
| `release_create` with `draft` | GitLab has no draft releases; create the release when it is ready |
| `release_create` with `prerelease` | GitLab has no pre-release flag; say it in the title or the notes |
| `release_create` with `generate_notes` | GitLab does not write release notes; write them, or use its changelog API |
| `pr review` to approve | Never offered, on either forge: approval stays human |

## Threads

A GitLab discussion is addressed by the merge request and the discussion together, so `pr comments` gives a thread as
`<number>:<discussion id>`, such as `42:6a9c1750b37d513a43987b574953fceb50b03ce7`. `pr reply` and `pr resolve` take that string as
their `thread`. A single comment has one too: replying to it turns it into a thread, as GitLab does.

## What does not change

- **Previews and fingerprints.** A write shows what it will send and refuses if the merge request moved since: a changed title, a
  new head, a thread resolved meanwhile (see [Writes](writes.md)).
- **The title rule.** `git.prTitle` is checked on `create` and `edit` against the title as written, before `Draft: ` is added.
- **A lost reply** is checked once with a read and never sent again.
- **The merge is pinned** to the head you saw (`sha`); a draft, a closed or merged request and a conflict are refused first.
- **Approval stays human:** `review` sends a comment or a request for changes.

## Comment watch

The same watch, on a merge request: the discussions are read every minute, each note is told once, your own and a bot's are skipped,
and it ends when the request is merged or closed ([Comment watch](comments-watch.md#on-gitlab)).

## Limits

- **`clone` is GitHub only.** It builds a GitHub URL from `git.cloneHost`.
- **GitLab under a path** (`https://example.com/gitlab`) and a host with a port are not supported: glab's `--hostname` takes a bare
  host name.
- **`jig-workflow`'s `pull-request-open` condition** reads `gh pr view`, so it does not see a merge request.
- **`jig-ops`** matches the event `jig-git:pushed` on `owner/name`; a project in a subgroup is announced with its full path, which
  `jig-ops` does not match yet ([Events](events.md)).
- **Not verified against a GitLab server;** see [Not verified yet](not-verified.md).
