# jig-ops: code map

Every file of `src/`, what it does and who calls it, and then one real call, `deploy run`, followed through the files.
Read it with the code open. Back to the [jig-ops overview](../README.md).

## The files

The plugin has three tools (`ci`, `deploy`, `runtime`) and two watches. Each tool has the same four parts: a `tool.ts`
(what Pi and `jig-core` see), a `params.ts` (the input, checked), the actions, and the code that talks to a system.
A test (`plugins/jig-core/test/code-maps.test.ts`) fails when a file of `src/` is missing here or a file listed here is
gone, so this table cannot drift from the code.

### Entry

| File | What it does | Called by |
|---|---|---|
| `index.ts` | The factory: registers the section, the three tools, the watch kinds and the listener for pushes | Pi, which loads it |

### Tools and their input

| File | What it does | Called by |
|---|---|---|
| `ci/tool.ts` | The `ci` tool: classifies each call (reads at the CI host, writes ask) and previews a rerun or trigger | `index.ts` |
| `ci/params.ts` | The `ci` parameters, and the checks that turn them into a call; no I/O | `ci/tool.ts` |
| `deploy/tool.ts` | The `deploy` tool: classifies, previews the exact command, and checks again before it runs | `index.ts` |
| `deploy/params.ts` | The `deploy` parameters; the version is checked to be an image tag; no I/O | `deploy/actions.ts`, `deploy/tool.ts` |
| `runtime/tool.ts` | The `runtime` tool: every action is a read, in the environment of the catalog | `index.ts` |
| `runtime/params.ts` | The `runtime` parameters, and the checks that turn them into a call; no I/O | `runtime/tool.ts` |

### The catalog

| File | What it does | Called by |
|---|---|---|
| `catalog.ts` | The `ops` section: each service, its environments, how it deploys, where it runs, its health address | most of the tools, `index.ts` and the CI watches |
| `ci/config.ts` | The `ci` entry of a service: which CI system builds it, and the fields each system has | `catalog.ts`, `ci/adapter.ts`, `ci/adapters.ts` and 5 more |
| `ci/settings.ts` | How often a CI watch polls, when it gives up, and the rules for "the artifact is ready" | `catalog.ts`, `ci/adapter.ts`, `ci/artifacts.ts` |
| `runtime/kubernetes/config.ts` | The Kubernetes target of an environment: context, namespace, pod selector, in-pod check | `catalog.ts`, the deploy methods and the runtime files |
| `deploy/methods.ts` | The deploy methods there are, in one place: the catalog checks them, the tool builds them | `catalog.ts`, `deploy/plan.ts` |

### Deploy

| File | What it does | Called by |
|---|---|---|
| `deploy/actions.ts` | The five actions: `plan`, `status`, `run`, `rollback` and `watch`; a change runs once | `deploy/tool.ts` |
| `deploy/plan.ts` | What a deploy or rollback would do, worked out before anything is done; the preview is made from it | `deploy/actions.ts`, `deploy/execute.ts`, `deploy/tool.ts` |
| `deploy/execute.ts` | Starts the command once; an unknown outcome is read once and never run again | `deploy/actions.ts` |
| `deploy/command.ts` | What a method hands the tool: the command as data, and what a rollback goes back to | `deploy/execute.ts`, `deploy/helm.ts`, `deploy/kubectl-image.ts` and 2 more |
| `deploy/helm.ts` | The Helm method: `helm upgrade --install`, `helm rollback`; the only module that starts helm | `deploy/execute.ts`, `deploy/methods.ts` |
| `deploy/kubectl-image.ts` | The kubectl method: `set image` with the tag changed only, and `rollout undo` | `deploy/methods.ts` |
| `deploy/records.ts` | What this session ran, kept in memory for `deploy status` | `deploy/actions.ts`, `deploy/tool.ts` |
| `watch.ts` | The `ops-rollout` watch: waits until every pod is ready on the version | `deploy/actions.ts`, `index.ts` |

### Runtime

| File | What it does | Called by |
|---|---|---|
| `runtime/kubernetes/pods.ts` | The pods of a service from `kubectl get pods`: ready, restarts, version; the `pods` action | `deploy/actions.ts`, `deploy/kubectl-image.ts`, `runtime/kubernetes/events.ts` and 5 more |
| `runtime/kubernetes/rollout.ts` | Is the service running the version it should? A plain function of pods and workloads | `deploy/actions.ts`, `deploy/plan.ts`, `runtime/kubernetes/events.ts` and 2 more |
| `runtime/kubernetes/wait.ts` | The `rollout` action: seen once or waited for, with back-off between reads | `deploy/actions.ts`, `deploy/execute.ts`, `deploy/plan.ts` and 2 more |
| `runtime/kubernetes/logs.ts` | The `logs` action: the last lines of one pod of the service | `runtime/tool.ts` |
| `runtime/kubernetes/events.ts` | The `events` action: what the cluster recently said about the service's objects | `runtime/tool.ts` |
| `runtime/kubernetes/inpod.ts` | The health check from inside a pod, with curl, on the port the catalog names | `runtime/tool.ts` |
| `runtime/health.ts` | The `health` action by address: one GET on the catalog's https address, no redirects | `runtime/tool.ts` |

### CI

| File | What it does | Called by |
|---|---|---|
| `ci/adapter.ts` | What a CI system must be able to do for the `ci` tool, and how it says what it cannot | the CI adapters, `ci/params.ts`, `ci/tool.ts` |
| `ci/adapters.ts` | The CI systems there are, in one table | `ci/params.ts`, `ci/watch.ts` |
| `ci/github-actions.ts` | The GitHub Actions adapter: checks, runs, logs, rerun, watch, through `gh` | `ci/adapters.ts`, `ci/autowatch.ts` |
| `ci/gitlab.ts` | The GitLab adapter: pipelines, jobs and logs through the REST API; rerun and trigger | `ci/adapters.ts` |
| `ci/jenkins.ts` | The Jenkins adapter: builds, stages and console logs; trigger with a crumb | `ci/adapters.ts` |
| `ci/model.ts` | What a CI system says about a check, in one shape with four buckets: pass, fail, pending, skipped | the three CI adapters and their watches |
| `ci/logs.ts` | Job logs from any CI system: cleaned, cut down, and scrubbed of anything credential-shaped | the adapters and watches that show a log |
| `ci/lost.ts` | A write whose reply was lost: one read says what the system shows, and it is never sent again | `ci/github-actions.ts`, `ci/gitlab.ts`, `ci/jenkins.ts` |

### CI watches

| File | What it does | Called by |
|---|---|---|
| `ci/watch.ts` | The `ops-ci` watch kind: waits until a CI run ends, whatever the system | `ci/adapter.ts`, `ci/autowatch.ts`, `ci/finished.ts` and 2 more |
| `ci/autowatch.ts` | Starts a watch by itself when `jig-git` announces a push for a repository in the catalog | `index.ts` |
| `ci/github-watch.ts` | The GitHub half of the CI watch: what to poll, and when it is done | `ci/github-actions.ts`, `ci/watch.ts` |
| `ci/gitlab-watch.ts` | The GitLab half: a pipeline that finished, or the jobs that must pass | `ci/autowatch.ts`, `ci/gitlab.ts`, `ci/jenkins-watch.ts`, `ci/watch.ts` |
| `ci/jenkins-watch.ts` | The Jenkins half: a build that finished, or the stages that must pass | `ci/autowatch.ts`, `ci/jenkins.ts`, `ci/watch.ts` |
| `ci/artifacts.ts` | "The artifact is ready": the rules of `ops.artifacts`, tested when a watch has passed | `ci/adapter.ts`, `ci/finished.ts`, `ci/github-checks.ts` and 5 more |
| `ci/finished.ts` | Publishes `jig-ops:ci-finished` when a CI watch reaches its finish line | `ci/watch.ts` |

### I/O

| File | What it does | Called by |
|---|---|---|
| `runtime/kubernetes/kubectl.ts` | The only module that builds kubectl arguments and starts kubectl | the deploy and runtime files that start kubectl |
| `runtime/kubernetes/failure.ts` | Turns the complaint of kubectl or helm into the one line a person can act on | `deploy/actions.ts`, `deploy/helm.ts`, `runtime/kubernetes/inpod.ts`, `runtime/kubernetes/kubectl.ts` |
| `ci/gh.ts` | GitHub through `gh`, which keeps its own sign-in; a lost write is read once | `ci/github-actions.ts`, `ci/github-checks.ts` |
| `ci/github-checks.ts` | What GitHub says about a commit, a run, tags and releases, with ETags to save requests | `ci/github-actions.ts`, `ci/github-watch.ts`, `ci/watch.ts` |
| `ci/gitlab-api.ts` | GitLab's REST API: the requests, what the replies hold, and job status as four words | `ci/gitlab-watch.ts`, `ci/gitlab.ts` |
| `ci/jenkins-api.ts` | Jenkins' remote access API: the requests, the replies, and results as four words | `ci/jenkins-watch.ts`, `ci/jenkins.ts` |
| `ci/request.ts` | The one request function of the HTTP adapters: direct over HTTPS, or through a company transport | `ci/gitlab-api.ts`, `ci/gitlab.ts`, `ci/http.ts` and 2 more |
| `ci/http.ts` | Reading a CI server's reply: what a status means to the person who has to fix it | `ci/gitlab-api.ts`, `ci/gitlab.ts`, `ci/jenkins-api.ts`, `ci/jenkins.ts` |

### Helpers

| File | What it does | Called by |
|---|---|---|
| `values.ts` | Small helpers: the invalid-input error, the shape an action hands back, ways to read kubectl's JSON | almost every file |

## How a call flows: `deploy run`

The agent deploys `1.4.3` of `orders-api` to `staging`, which the catalog says uses Helm.

1. **The class.** `jig-core`'s `tool_call` hook calls `classify` in `deploy/tool.ts`. It reads the input with
   `parseCall` (`deploy/params.ts`) against the catalog (`catalog.ts`): the service, the environment and the
   version, which must look like an image tag. `refuse` stops a deploy to an environment with no `deploy` object,
   such as production. The call is a write in `staging`.
2. **The rule.** `jig-core` decides: a write to a test environment asks. It calls `preview` in `deploy/tool.ts`.
3. **The plan.** `preview` calls `planRun` in `deploy/plan.ts`. It reads the cluster with `look`
   (`runtime/kubernetes/wait.ts`, which starts kubectl through `runtime/kubernetes/kubectl.ts`), and asks the
   environment's method for the command: `deployerOf` in `deploy/methods.ts` gives `deploy/helm.ts`, which builds
   the `helm upgrade --install` arguments from the catalog. The plan has a fingerprint of the command and the
   versions running now.
4. **The screen.** You see the exact command, the version running now and the one asked for. You answer `y` in Pi.
5. **The action.** `execute` in `deploy/tool.ts` parses and refuses again, then `runAction` in `deploy/actions.ts`
   plans again and calls `change`.
6. **The check.** `checkUnchanged` in `deploy/execute.ts` compares the fingerprint you approved with the plan made
   now. If the cluster moved meanwhile, nothing runs.
7. **The command, once.** `startCommand` starts helm through `deploy/helm.ts`, the only module that does. If helm
   runs too long or the call is cancelled, the outcome is unknown: `lookOnce` reads the rollout one time, and the
   command is never run again.
8. **The record and the answer.** `deploy/records.ts` remembers what was run, for `deploy status`. The answer says
   "Started the deploy of 1.4.3 ..." and points to `deploy watch`.
9. **The watch.** The agent calls `deploy watch` with the same version. `watchAction` starts the `ops-rollout`
   watch (`watch.ts`). `jig-core` polls it, `rollout.ts` decides from the pods whether the rollout is complete, and
   one message tells the agent when it is.

A failed command is an error that says why (`runtime/kubernetes/failure.ts` turns the complaint of helm or kubectl into
one line), and the plan is not run a second time.

Back to the [jig-ops overview](../README.md).
