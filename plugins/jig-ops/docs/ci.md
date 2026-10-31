# CI: the `ci` tool

How the `ci` tool looks at a service's CI, changes it and waits for it, on GitHub
Actions, GitLab CI or Jenkins. Back to the [jig-ops overview](../README.md). The
catalog fields it reads are in [The catalog](catalog.md#ci).

A call names a `service` from the catalog, and the catalog says which CI system
builds it and where. A call never names an address, a project, a job or a
workflow. `jig-core` governs every call, and `ci` was `jig-git`'s `checks` tool
before CI moved here.

## What each system can do

An adapter has the actions it can do and the parameters each takes; the table is
the check. An action it does not have, or a parameter that action does not take,
is invalid input: the call is blocked before anyone is asked, and the message
names the adapter and says what it does have.

| Action | GitHub Actions | GitLab CI | Jenkins |
|---|---|---|---|
| `status` | checks of a pull request, branch or commit; `required_only` | the pipeline of a branch, commit or id, its jobs counted | the last build or one by number, its stages counted |
| `runs` | workflow runs, by branch, commit or state | pipelines, by branch, commit or status | builds, by result |
| `run` | one run's jobs and steps, and its artifacts | one pipeline's jobs, with why one failed | one build's stages |
| `log` | a failed job's log | a failed job's log | the console of the last failed build, or of one |
| `rerun` | the failed jobs, or the whole run | the failed jobs of a pipeline | not offered |
| `trigger` | not offered | a pipeline on a `ref`, with variables | a build, with parameters |
| `watch` | the six finish lines below | a pipeline, or named jobs | a build, or named stages |

- **Why Jenkins has no `rerun`.** Its remote API has none: rebuilding is a plugin,
  and a build that took a password as a parameter cannot be rebuilt from what the
  API shows. `trigger` starts a new build with the parameters the call names.
- **Why GitHub Actions has no `trigger`.** Starting a workflow by hand can deploy,
  and deploys have their own tool and their own rules. The catalog's `workflow`
  narrows `runs` to one workflow.
- **GitLab retries failed jobs only.** To run everything again, `trigger` on the
  same `ref`.
- **A log is capped and scrubbed.** At most 400 lines, the tail or the lines that
  match `grep`; terminal sequences and control characters out, and anything that
  looks like a credential replaced. A log of more than 8 MiB is refused.
  - **`gh` 2.97 and later** refuse to print a log, which is text with colour codes in it, unless `--allow-escape-sequences` is given.
    The plugin gives it when `gh help api` lists the flag (asked once), and an older `gh`, which fails on an unknown flag, is not given it.

## Classification, previews and lost replies

- **Reads are `external` reads and run.** `rerun` and `trigger` are `external`
  writes, so they ask. `watch` is a local write: it starts something on this
  machine and changes nothing at the CI host.
- **The CI host is `external` unless the catalog names an `environment`** in the
  service's `ci` entry. A name `jig-core` does not know counts as production: reads
  there are masked and writes are denied before anyone is asked.
- **A write is previewed.** The preview names the service, what is sent and the
  state it is sent against (the failed jobs of the pipeline, the newest pipeline of
  the `ref`, the next build number). It carries a fingerprint.
  - When the call runs, the plan is worked out again.
  - If the fingerprint differs the call is refused: "changed since the preview ...
    Nothing was sent".
- **A write is sent once.** A timeout, a connection that broke, a gateway error or
  a cancelled call may mean that the CI system did what it was asked. The tool
  then reads once and tells the model what it found. It never sends the request
  again, so one `rerun` cannot become two.
- **Jenkins needs a crumb for a POST.** It is requested from
  `/crumbIssuer/api/json` before anything is sent; a server with no crumb issuer
  answers 404 and none is used. The session cookie the crumb is tied to goes back
  with the POST. A failure to get the crumb is a plain failure: nothing was sent.

## Signing in

`gitlab` and `jenkins` entries have an `auth`, exactly one of:

| Form | What it does |
|---|---|
| `{ "token": "pass:ci/gitlab" }` | GitLab: the secret is sent as the `PRIVATE-TOKEN` header |
| `{ "user": "ci-bot", "token": "pass:ci/jenkins" }` | Jenkins: user and API token, HTTP basic authentication |
| `{ "signIn": "corp" }` | A sign-in service a company plugin registered supplies the headers of each request |
| `{ "transport": "corp" }` | A transport carries the request and signs it in itself. The address may then be plain `http` |

A secret is a reference, resolved when the request is made, and an error about it
never repeats the value. Direct requests need an `https` address. A redirect is
never followed, because it would carry the credential to an address the catalog
never named. A GitHub Actions entry signs in with `gh`, which keeps its own login.

## Watching CI

A watch runs on `jig-core`'s watch engine, outside the sandbox, and the call that
starts it returns at once. The kind is `ops-ci`; its spec holds the name of the
service and what to follow, never an address, a project or a job, so a poll always
reads where the catalog says. It was `jig-git`'s `github` kind.

![A push or ci watch starts a watch that polls the CI system until a finish line is reached; one message wakes the agent, and an artifact-ready event may lead a company plugin to deploy, only through jig-core](../../../docs/img/ci-watch.svg)

*From a push to a wake-up: the watch polls until its finish line, one message starts the agent's turn, and an artifact-ready event may lead a company plugin to deploy, but only through `ctx.executeTool`, so `jig-core` still asks for a test environment unless a rule allows it, and denies production.*

1. **It starts by itself** after a push and after a pull request is created.
   `jig-git` announces `jig-git:pushed`; when a service of the catalog has that
   `repo` and a `ci` entry, a watch starts on the pushed commit (`ops.watch.auto`).
   On GitLab the `repo` is the project's whole path, groups and subgroups included,
   so `platform/payments/orders-api` matches only that project.
   A newer push to the same branch replaces the watch of the older commit.
   Or the agent calls `ci watch`.
2. **Its finish line is explicit, never "all checks".**
3. **It polls every 30 seconds (`ops.watch.pollSeconds`).** GitHub's polls carry
   ETags, so an unchanged answer (`304`) does not count against the rate limit, and
   the watch follows `X-Poll-Interval`.
4. **It sends one message per result,** which starts a turn of the agent: counts and
   the commit when it passes; when it fails, the failing checks, their links and the
   lines around the first error in the log.
5. **It gives a "still waiting" notice after 30 minutes and gives up after 60,**
   unless `ops.watch.stallMinutes` and `ops.watch.timeoutMinutes` say otherwise.
   Open watches survive a restart.

| Finish | GitHub Actions | GitLab CI | Jenkins |
|---|---|---|---|
| `required` (default) | The checks branch protection requires, or every check when none is required | The jobs in `required` of the entry, else the whole pipeline | The stages in `required`, else the whole build |
| `check` | One named check; skipped is a failure | One named job | One named stage |
| `run` | One run; the first failed job ends it | The pipeline; the first failed job ends it | The build |
| `approved`, `merged` | A pull request state | not offered | not offered |
| `comment`, `tag`, `release` | A bot comment, a new tag or release matching `pattern` | not offered | not offered |

- **GitLab finds the pipeline** by its id, by the full commit id, or, with only a
  branch, as the newest one when the watch starts (or the first one created after
  it). **A pipeline waiting for a manual job has passed:** everything that runs by
  itself is done, and the message says so. A job that may fail does not fail the
  pipeline.
- **Jenkins follows a build** by number, the one running when the watch starts, or
  the first one scheduled after it began (clocks are allowed ten seconds of
  difference). Stages come from the Pipeline REST API plugin; a build without them
  cannot be watched by stage, and the poll says what is needed.
- **A named stage or job that is skipped will never run,** so for a watch that waits
  for it, that is the end.

## Artifacts, and why `jig-ops` never deploys from them

Rules in `ops.artifacts` say when an artifact is ready. They are tested when a
watch has passed, and what they find is announced on Pi's event bus as
`jig-ops:artifact-ready`:
`{ repo, pr?, sha, kind: image | tag | release, ref, source: check | log | comment | tag | release }`.

- a named job succeeded for the head commit;
- a version is read from that job's log by a pattern, and it contains the head's
  short commit id;
- a bot comment on the pull request matches a pattern (GitHub);
- a tag or release matches a pattern, and is on the head commit or carries its
  short id (GitHub).

A version that does not contain the watched commit is ignored. A rule that cannot
be tested (the log has expired, say) does not lose the watch's result: the message
says so. Jenkins keeps one log for the whole build, so a rule can name a stage but
cannot read a version from its log; GitLab has no pull request comments, tags or
releases here.

What happens after "artifact ready" is a company decision. A company plugin may
listen for the event, and it always tells the agent.

It may start a deploy by itself only when all of these hold:
- its automatic deploy setting is on (off by default);
- the watch was started for a deploy you asked for;
- the target is `staging` and replaces no one else's build there.

The deploy goes through `ctx.executeTool`, so `jig-core` still asks for a test
environment unless your rule allows it, and denies production.

## Events

- **`jig-git:pushed`** (listened to): `{ repo, branch, sha, pr? }`. See
  [jig-git's events](../../jig-git/docs/events.md). The payload is checked before
  anything is done with it: anyone can publish on the bus.
- **`jig-ops:artifact-ready`** (published): the payload above. It was
  `jig-git:artifact-ready` while `jig-git` ran the watch. The plugin that publishes
  an event owns its name, and `jig-git` publishes it no longer.
- **`jig-ops:ci-finished`** (published): a CI watch reached its finish line, for a commit:
  `{ repo, service, system, sha, branch?, pr?, finish, outcome, summary }`. `repo` is the catalog's
  `repo`, `finish` the watch's finish line (`required` on GitHub, `pipeline` or `jobs` on GitLab,
  `build` or `stages` on Jenkins, and so on), and `outcome` `passed` or `failed`.
  - **Why it exists:** a watch's own result is one line for the agent and names no commit.
    `jig-workflow`'s `checks-pass` needs "the required checks passed at this commit".
  - **When it is not published:** the service has no `repo`, the watch does not name the commit
    (a watch of one run by its id, or a Jenkins build started by hand), or it ended otherwise than `passed` or
    `failed` (timed out, stopped). A listener that fails does not change the watch's result.
- **`jig:watch-done`**, from `jig-core`'s engine: a watch finished, with its result.
