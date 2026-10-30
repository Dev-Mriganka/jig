# Not verified yet

What the tests of `jig-ops` do not cover. Back to the [jig-ops overview](../README.md).

Written from the Kubernetes and Helm documentation, from the behaviour of the
programs as an earlier harness met them, and against a fake `kubectl`, a fake
`helm`, a fake `gh` and fake GitLab and Jenkins servers on this machine. Nothing
here has been tried against a real cluster, a real Helm, a real health address,
GitHub, GitLab or Jenkins.

## Helm

- **The shape of `helm history --max 2 -o json`** (the latest two revisions,
  oldest first, each with a `revision` number) and of `helm get values --revision
  N --all -o json` (a chart's defaults and the user's values merged, with the
  version under `image.tag`). A rollback's "going back to" line relies on both.
- **`helm upgrade --install ... --wait=false` with hooks.** Helm waits for
  hooks, such as a pre-upgrade migration job, for up to five minutes even without
  `--wait`.
  - The tool allows six, so that it is helm that gives up and not this plugin that stops it.
  - A helm that is stopped part way can leave a release in `pending-upgrade`; the tool treats that as an unknown outcome and says
    that a locked release is the user's to look at.
- **helm's own words** for an expired sign-in, an unreachable cluster, a locked
  release (`another operation (install/upgrade/rollback) is in progress`), a
  release or a chart that is not found. Another version may word them
  differently, and the tool then shows helm's first lines instead.
- **A chart that does not take the version as `image.tag`.** The deploy would
  succeed and change nothing. The rollback preview shows `its version could not
  be read`.

## Kubernetes

- **kubectl's own words** for the same failures: an expired or refused sign-in,
  an unreachable cluster, a missing context or namespace, a forbidden read or
  change, a pod that is gone or a container that has not started.
- **`kubectl set image` and `kubectl rollout undo` on a real workload,** including
  a paused deployment, and the revision `rollout undo` chooses. The tool assumes
  the second newest revision, as the replica sets' revision annotation or a
  statefulset's controller revisions show them.
- **The JSON of `kubectl get events`.** The core API and the events API keep the
  time of an event in different fields; the tool reads the ones it knows. Events
  of other API groups are not read.
- **`kubectl exec` and `curl` in a real pod,** including a container image without
  `curl` and the exit codes `kubectl` passes on.
- **Rollouts that are not a deployment or a statefulset** (a daemonset, a rollout
  controller of another product), and a statefulset updated with `OnDelete`. They
  are judged from their pods.
- **A kubeconfig sign-in helper that needs Pi's environment.** Only `KUBECONFIG` is
  passed on.

## Health addresses

- **TLS to a real host,** including a company certificate authority. The fake
  `fetch` cannot show it.
- **What `fetch` does with `redirect: "manual"`** in the Node that runs Pi. The
  tests give it a response with status `302`; a real server and a real Node are
  assumed to do the same.

## `jig-core` in a live session

- **The watch engine.** The kind was polled directly, with a fake clock. The first
  poll about two seconds after the start, the ten-second interval, the stall
  notice, the single message to the agent and the saved file were read in
  `jig-core`'s code and not run in Pi.
- **The kind of an environment.** The tools ask `jig-core` for the kind of a name
  on every call; the fake answers like `jig-core` does (a name nobody defined is
  production), but the real answer was read in its code, not run.
- **Programs found on `PATH`.** `jig-core` does not run a program found only in a
  folder the agent can write to. `kubectl` and `helm` are assumed to be installed
  in a system folder.
- **The review screen** of a preview, and the masking of a production result, were
  not seen in the terminal.

## CI: what the adapters rely on

Each fact below was read in the official documentation on 2026-10-30. The pages
are listed so that a change in them can be found.

### GitLab CI

- **Pipelines** ([API](https://docs.gitlab.com/api/pipelines/)):
  - `GET /projects/:id/pipelines` filters by `ref`, `sha`, `status` and `scope`,
    orders by `id` (newest first by default) and pages with `page` and `per_page`.
    Its entries show `id`, `status`, `ref`, `sha`, `source`, `web_url`,
    `created_at` and `updated_at`, and no finish time.
  - The statuses are `created`, `waiting_for_resource`, `preparing`,
    `waiting_for_callback`, `pending`, `running`, `success`, `failed`, `canceling`,
    `canceled`, `skipped`, `manual` and `scheduled`.
  - `POST /projects/:id/pipelines/:pipeline_id/retry` retries failed or canceled
    jobs, and does nothing if there are none. It answers `409` when a retry of the
    pipeline is running and `429` over the rate limit.
  - `POST /projects/:id/pipeline` takes a required `ref` (in the query string, in
    the documentation's example) and `variables`, an array of `key`, `value` and
    an optional `variable_type`, which defaults to `env_var`.
- **Jobs** ([API](https://docs.gitlab.com/api/jobs/)):
  - `GET /projects/:id/pipelines/:pipeline_id/jobs` lists the jobs of a pipeline,
    newest first, retried ones only with `include_retried`. A job has `id`, `name`,
    `stage`, `status`, `allow_failure`, `web_url` and `failure_reason`.
  - `GET /projects/:id/jobs/:job_id/trace` is the job's log: `200`, or `404` when
    the job or its log is not there.
- **Sign-in and addressing** ([authentication](https://docs.gitlab.com/api/rest/authentication/),
  [REST](https://docs.gitlab.com/api/rest/)):
  - a personal, project or group token goes in the `PRIVATE-TOKEN` header; a missing or wrong one is `401` with
    `{"message": "401 Unauthorized"}`;
  - the base path is `/api/v4`;
  - a project is its id or its namespaced path with `/` written `%2F`;
  - lists default to 20 items, at most 100, and a path that is not encoded matches nothing and is `404`.

What the tests could not settle:

- **Variables in the body.** The documentation shows `ref` in the query and a JSON
  body only for `inputs`. The tool sends `ref` in the query and `variables` as JSON
  with `Content-Type: application/json`, which is the same shape. No example of
  `variables` was read.
- **The status of a retry that worked.** The documentation does not give it; the
  tool takes any `2xx`. A `5xx` is treated as a reply that may have been lost.
- **`per_page` on the jobs list.** That page does not document it; the general
  pagination page says every list takes it. A pipeline with more than 100 jobs is
  read as its first 100.
- **A pipeline in `manual`** is counted as finished and passed, with a note. A job
  in `manual` is pending.
- **The commit filter wants the whole commit id.** The tool asks for 40 characters
  rather than let a short id match nothing without a word.
- **A server below a path** (`https://host/gitlab`), a self-managed server with its
  own certificate authority (start Pi with `NODE_EXTRA_CA_CERTS`), and the real size
  of a job log (the tool refuses more than 8 MiB).

### Jenkins

- **Remote access API** ([page](https://www.jenkins.io/doc/book/using/remote-access-api/)):
  - an object's data is at its address plus `/api/` (XML or JSON), with `depth` and `xpath`;
  - a build is started by a POST to `/job/<name>/build` or `/job/<name>/buildWithParameters` (parameters as form data);
  - on a secured server the requests use HTTP basic authentication with a user and an API token, "preferred instead of crumbs".
- **Scripted clients** ([page](https://www.jenkins.io/doc/book/system-administration/authenticating-scripted-clients/)):
  - Jenkins does not negotiate, so it answers `403`, not `401`, to missing credentials, and the first request must carry them;
  - a crumb is requested from `/crumbIssuer/api/json` and sent in the header named by `crumbRequestField`, with the value of
    `crumb`.
- **CSRF protection** ([page](https://www.jenkins.io/doc/book/security/csrf-protection/)):
  requests that authenticate with an API token are exempt. A crumb is tied to the web
  session it was issued in, so a client sends back the session cookie with it. The
  tool asks for a crumb in every case: a server with no issuer answers `404` and none
  is used.
- **Builds** ([Run](https://javadoc.jenkins.io/hudson/model/Run.html),
  [Result](https://javadoc.jenkins.io/hudson/model/Result.html),
  [Job](https://javadoc.jenkins.io/hudson/model/Job.html)):
  - a build's result "may be null if the build is ongoing";
  - `isBuilding` is true until it is completed, and the timestamp is when it was scheduled;
  - the results are `SUCCESS`, `UNSTABLE`, `FAILURE`, `NOT_BUILT` and `ABORTED`.
- **The API help page every Jenkins server serves** at `.../api/` (read on a public
  server, [example](https://hub.spigotmc.org/jenkins/job/BuildTools/6/api)):
  - `tree=` limits the fields of a reply, with `jobs[name]{0,10}` for a range;
  - the console of a running build is read in pieces with `start` and the `X-Text-Size` and `X-More-Data` headers (not used: the
    tool reads a finished build's console whole).
- **Stages** ([Pipeline REST API plugin](https://plugins.jenkins.io/pipeline-rest-api/)):
  `/job/<name>/<run>/wfapi/describe` has `stages`, each with `id`, `name`, `status`,
  `startTimeMillis` and `durationMillis`.

What the tests could not settle:

- **Names that the pages above do not list:** they are Jenkins' own, and are written from how Jenkins answers.
  - The field names the tool asks for with `tree=`: `number`, `result`, `building`, `timestamp`, `duration`, `url`; on a job
    `buildable`, `inQueue` and `nextBuildNumber`.
  - The permalinks `lastBuild` and `lastFailedBuild`, and `consoleText`.
  - The Javadoc lists the permalink constants but not their spelling.
- **The status words of a stage.** The plugin page shows `SUCCESS`, `FAILED` and
  `PAUSED_PENDING_INPUT`; `IN_PROGRESS`, `NOT_EXECUTED`, `ABORTED` and `UNSTABLE`
  are from memory. A word nobody knows counts as a failure.
- **A queued build's answer.** `201` with the queue item in `Location`, and `303`
  when the same request is already queued (since Jenkins 2.319.1), were read in
  Jenkins' issue tracker and community pages and its changelog, not on the pages
  above.
- **The crumb with a sign-in service or a transport,** where the session is the
  company's, and the cookie a crumb is tied to.
- **A job in a folder** as `/job/folder/job/name`, a multibranch job (name its branch
  job in the entry), and the real size of a console (the tool refuses more than
  8 MiB).
- **Clocks.** A build started without a number is the first one scheduled after the
  watch began, with ten seconds of difference allowed between the clocks of Pi and
  the server.

### GitHub Actions, as `jig-git`'s `checks` tool left it

- **GitHub itself.** `gh api` prints a `304` as the status line and headers, then
  `gh: HTTP 304` on standard error, and exits with 1.
  - That was checked with gh 2.92 against a local server, and the tests rely on it.
  - Rate limits, `X-Poll-Interval` on these endpoints, and polling with a single sign-on login have not been tried.
  - `gh run watch` does not support fine-grained tokens.
- **Which checks are required** is read from the protection and the rulesets of the
  base branch, which was not tried on a real repository. A repository that hides them
  from read access has every check counted. For a pull request, `required_only` relies
  on `gh pr checks --required`.
- **Pages.** Reviews, comments, tags and releases are read from the first page only
  (100, 100, 100 and 30); more than 100 check runs are read up to 300.
- **The artifacts of a run** are listed with `run`, and a run whose artifacts cannot
  be listed still shows its jobs.
- **Resuming a watch on start** is `jig-core`'s. The watch's state is plain JSON, and
  a poll that resumes from a saved state is tested.
- **Pi's event bus** was checked against an older Pi (1.2), not 1.4. `jig-ops`
  listens for `jig-git:pushed` and publishes `jig-ops:artifact-ready` with
  `pi.events`, and the messages that start a turn are `jig-core`'s.
