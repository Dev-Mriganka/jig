# jig-k8s: Kubernetes reads

**Status: built, not yet tried against a real cluster.** This README is the
specification the code follows. [Not verified yet](#not-verified-yet) lists what
needs a real cluster.

`jig-k8s` gives the agent one tool, `k8s`, that reads a service's state in a
Kubernetes cluster through `kubectl`. A call names a **service** and an
**environment** from configuration. The configuration holds the kubectl
context, the namespace and the pod selector, so the model never types them.
`jig-core` governs every call.

```text
k8s pods         {service: "orders-api", environment: "staging"}
k8s status       {service: "orders-api", environment: "staging", waitFor: "1.4.3"}
k8s logs         {service: "orders-api", environment: "staging", tail: 100, sinceSeconds: 600}
k8s api          {service: "orders-api", environment: "staging", path: "/actuator/health"}
```

## Tool: `k8s`

| Action | Kind | What it does |
|---|---|---|
| `pods` | read | A service's pods: ready, status, restarts, age and image tag |
| `status` | read | The deployment or statefulset behind the pods: ready replicas, revision, image. With `waitFor` it polls until the pods run a version, and says `Running` or `Still rolling` |
| `logs` | read | The last lines of one pod's log: the pod named, or the first ready one |
| `api` | read | A `GET` on a path of the service's API from inside a ready pod. Test environments only |

Restarts, scaling and every other change are not part of this plugin.

| Parameter | Used by | What it does |
|---|---|---|
| `action` | all | `pods`, `status`, `logs` or `api` |
| `service` | all | A name from the `k8s` section. An unknown name is refused with the names there are |
| `environment` | all | One of that service's environments. An unknown name is refused with the ones there are |
| `waitFor` | `status` | An image tag or version, exactly as `pods` shows it (1 to 128 characters of letters, digits, `. _ + -`). The call returns when every live pod is ready on it |
| `timeoutSec` | `status` | How long `waitFor` waits: 1 to 600, 300 by default. Only with `waitFor` |
| `pod` | `logs` | A pod of the service, as `pods` shows it. Default: the first ready pod. A pod that is not one of the service's is refused |
| `container` | `logs` | A container of the pod, an init container too. Default: the configured `container`, else the pod's only container, else the container or image named like the service, else kubectl's own default |
| `tail` | `logs` | Lines from the end: 1 to 2000, 200 by default |
| `sinceSeconds` | `logs` | Only lines from the last this many seconds: 1 to 86400 |
| `previous` | `logs` | The log of the container's previous run, which is how a crash is read |
| `path` | `api` | Starts with `/`, then at most 400 characters of letters, digits and ``. _ ~ / ! $ & ' ( ) * + , ; = : @ % -``, then at most one `?query` of the same. No `..`, also when percent-encoded once or more |

A call with a missing or an unused parameter is refused with the usage line of
its action, such as `k8s logs does not use waitFor. Usage: k8s logs {service,
environment, pod?, container?, tail?, sinceSeconds?, previous?}`.

### What a result looks like

Plain text, short. `pods`:

```text
2 pods of orders-api in staging (namespace orders-staging):
- orders-api-0: 1/1 ready, Running, 0 restarts, 5m, image 1.4.3
- orders-api-1: 0/1 ready, CrashLoopBackOff, 7 restarts, 60m, image 1.4.2
```

`status` says what the workload and the pods show, in one of four words.
`Running` means as many pods as the workload wants, all ready, all on the
version (with no `waitFor`, all agreeing with each other). A pod that is being
deleted counts for nothing.

```text
orders-api in staging (namespace orders-staging): Still rolling after waiting 5m00s: 1 of 2 pods ready on 1.4.3; pods run 1.4.3, 1.4.2.
Workload: StatefulSet orders-api, 2/2 ready, 1 updated, revision orders-api-5d9f -> orders-api-7c1a, image 1.4.3.
- orders-api-0: 1/1 ready, Running, 0 restarts, 4m, image 1.4.3
- orders-api-1: 1/1 ready, Running, 0 restarts, 2h, image 1.4.2  <- not ready on 1.4.3
```

| Verdict | Meaning |
|---|---|
| `Running` | The version (or, with none, a single version) runs on every pod, and they are all ready |
| `Still rolling` | Not yet. After a wait that ran out of time it says how long it waited |
| `Failing` | A pod waits for a reason that does not pass by itself (`CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError`, `InvalidImageName`). It names the pod and the next step. A wait ends at once |
| `No pods` | Nothing matches the selector. A wait goes on, as pods may yet appear |

`logs` is a line with the pod, the container and the limits, then the lines.
`api` is `GET /actuator/health on orders-api-0:8080 -> HTTP 200` and the body.
A non-2xx status is a result, not an error.

## Rules

- **Reads only.** The only kubectl commands the code can build are `get`,
  `logs` and, for `api`, `exec`. `delete`, `scale`, `apply`, `edit`, `rollout
  restart`, `port-forward`, `cp` and the rest are not refused at run time: they
  are not in the code, and tests ask for more than thirty of them. A rollout is read
  with `get`, not with `rollout status`.
- **One place builds kubectl.** `kubectl` is built and run only in
  `src/kubectl.ts`, from an argument list, never a shell, through `jig-core`'s
  `exec`. `jig-core` gives it a short environment; this plugin adds the path of
  the kubeconfig (`KUBECONFIG`) and nothing else.
- **The model names a service, not a cluster.** Every command starts with
  `--request-timeout`, `--context=` and `--namespace=` from the configured
  target, and `kubectl get pods` is given the target's selector. A call has no
  parameter for a context, a namespace, a selector, a flag or a verb. A
  `pod` or `container` that a call names must be one the cluster lists for the
  service, and the name that reaches kubectl is the listed one. A pod or a
  container whose name Kubernetes would not allow (one that could be read as a
  flag) is left out of what kubectl says.
- **Classification.** A call is a read in the `jig-core` environment that the
  service's environment maps to (by default its own name). A read of
  production is allowed and `jig-core` masks the result; this plugin masks
  nothing itself, and a name that `jig-core` does not know counts as
  production. The call's action is its `action`, so a rule such as `{ "tool":
  "k8s", "action": "api", "decision": "ask" }` covers one action.
- **Invalid input is not asked about.** An unknown service or environment, a
  parameter that breaks a limit above, or an `api` call where it is not
  allowed, is blocked with a message that says what to change, and lists the
  names there are. Nobody is asked about a call that cannot run.
- **`api` is for test environments only.** It is a `GET`: there is no method, no
  header and no body to give, so nothing goes on kubectl's or curl's standard
  input and no data flag is ever built. It runs `kubectl exec <pod> -c
  <container> -- curl -sS -m 20 -X GET -w "\n__status:%{http_code}"
  http://localhost:<port><path>` in the first ready pod, in the configured
  container and on the configured port. The path is the only text of the call
  in the command line, as one argument. **The container must have `curl`**;
  if it has none the tool says so. The reply is capped at 2 MiB, and only the
  status and the body come back; a reply over the cap is cut and says that its
  status was not read.
- **`api` is refused in production, twice.** `classify` refuses an
  environment that maps to `production`, the name `jig-core` always treats as
  production. A company can call its production something else, and the
  contract gives a plugin no way to ask `jig-core` what an environment is. So
  before it runs anything, `api` reads `jig-core`'s own decision for this very
  call (its `jig:decision` event, which names the kind of the environment) and
  refuses unless that says the environment is not production. A call
  `jig-core` did not announce cannot be vouched for, and is refused too.
- **Waiting.** `status` with `waitFor` reads the pods and the workloads, then
  again after 2 seconds, then after each wait half as long again, never more
  than 15 seconds apart, up to `timeoutSec` (at most 10 minutes). It looks one
  more time at the limit. It ends when the version runs, when a pod fails, or
  when time is up; the last two are results. A wait the user stops is an
  error that says the rollout itself is not affected.
- **Lines are data.** Terminal sequences and control characters are removed
  from log lines and API bodies, so a hostile log cannot act on the terminal.
  `jig-core` masks production results, removes secrets, and cuts a long result
  with the whole text in a file.
- **Sign-in is the user's.** The tool never signs in. A kubeconfig that is
  expired, a network or VPN failure, a user who may not read: each is one line
  that says whose it is to fix, and the tool does not retry by itself.
- **Facts.** After a call, its record carries a few numbers: for `pods` the
  pod count and how many are ready, for `status` the verdict, for `logs` the
  line count, for `api` the status.

## Configure

In `~/.pi/agent/jig.json`, under `k8s`. An unknown field is an error, and the
tool then does nothing until the file is fixed (`/jig` lists the problems).

| Field | Meaning |
|---|---|
| `services` | Required. A map from a service name to a map from an environment name to that environment's entry. Names are 1 to 40 letters, digits, `.`, `_` and `-` (environments: letters, digits, `_`, `-`, starting with a letter) |
| `environments` | Optional. A map from an environment name to the `jig-core` environment it is classified in. Default: the same name. A name that no service has is an error |

| Field of an entry | Meaning |
|---|---|
| `context` | Required. The kubectl context, as `kubectl config get-contexts` shows it. A cloud context may hold `:` and `/` |
| `namespace` | Required. The namespace the service runs in |
| `selector` | Required. The label selector of the service's pods: one to ten `key=value` pairs, comma separated, equality only, such as `app=orders-api`. The deployment or statefulset behind the pods is the one whose selector or pod template carries these labels |
| `container` | For `api`, required: the container curl runs in. For `logs`, the container read when a call names none |
| `port` | For `api`, required: the port the service listens on, inside the pod |

```json
{
  "k8s": {
    "services": {
      "orders-api": {
        "staging": {
          "context": "test-cluster",
          "namespace": "orders-staging",
          "selector": "app=orders-api",
          "container": "orders-api",
          "port": 8080
        },
        "production": {
          "context": "prod-cluster",
          "namespace": "orders",
          "selector": "app=orders-api"
        }
      }
    },
    "environments": { "staging": "staging", "production": "production" }
  }
}
```

`kubectl` uses the user's own kubeconfig and its sign-in. A kubeconfig whose
sign-in helper needs environment variables must set them itself (its `exec.env`
field): `jig-core` does not pass Pi's environment on.

## Company part (in the company plugin)

- **The services table:** for each service and environment, the cluster
  context, the namespace and the pod selector, and for test environments the
  container and port of its API.
- **The environments:** the `jig-core` environments those names map to
  (`environments` above), added to `jig-core` with their kind, test or
  production.
- **The kubeconfig and its sign-in.** They belong to the user's machine, not to
  this plugin.
- **An overlay skill** that names the services and what each one is for. The
  model learns the service names from it, and from the message about an unknown
  one.

## Not verified yet

Written from the Kubernetes documentation, `kubectl`'s behaviour as an earlier
harness used it, and a fake `kubectl` on this machine. Not tried against a
real cluster:
- **kubectl's own words.** The failure messages match the texts of the
  versions the earlier harness met: an expired or refused sign-in, an
  unreachable cluster, a missing context or namespace, a forbidden read, a pod
  that is gone or a container that has not started. Another version may word
  them differently, and the tool then shows kubectl's first lines instead.
- **`kubectl exec` and `curl` in a real pod,** including a container image
  without `curl` and the exit codes `kubectl` passes on.
- **The decision event in a live session.** `api` relies on `jig-core`
  announcing its decision before the call runs. That was read in `jig-core`'s
  code and tested with a fake, not run in Pi.
- **Rollouts that are not a deployment or a statefulset** (a daemonset, a
  rollout controller of another product), and a statefulset updated with
  `OnDelete`. They are judged from their pods.
- **A kubeconfig sign-in helper that needs Pi's environment.** Only
  `KUBECONFIG` is passed on.
- **The review screen and the masking** of a production result were not seen
  in the terminal.

## Layout

```text
jig-k8s/
  src/
    index.ts      the plugin: the tool, its declaration and the k8s section, and the listener for jig-core's decisions
    tool.ts       the k8s tool: its description, its classification and execute
    params.ts     the schema, the usage lines and the checks on a call, the path rules of api
    config.ts     the k8s section: validation, targets, finding the service and environment a call names
    kubectl.ts    the kubectl command builder: the only place that builds or starts kubectl
    failure.ts    kubectl's complaint as one line that says what to do
    pods.ts       reading pods, the first ready pod, the pods action
    rollout.ts    the workloads behind the pods and the verdict on a rollout
    status.ts     the status action and the wait with its backoff
    logs.ts       the logs action
    api.ts        the api action: curl in a pod
    decisions.ts  jig-core's decisions, as far as api needs them
    values.ts     small helpers
  skills/   k8s/SKILL.md: pods first, then status, logs around an error, api in test environments only
  test/     against a fake kubectl (a script on a temporary PATH) and a fake jig-core
```
