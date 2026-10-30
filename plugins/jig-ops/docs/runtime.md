# Runtime: the actions and what they return

The parameters of the `runtime` tool, what each action returns, and the rules the
Kubernetes adapter follows. Back to the [jig-ops overview](../README.md).

Every action is a read. A call names a **service** and an **environment** from
the [catalog](catalog.md); the context, the namespace and the pod selector are
the catalog's, so the model never types them. A call with a missing or an unused
parameter is refused with the usage line of its action, such as `runtime logs
does not use waitFor. Usage: runtime logs {service, environment, pod?,
container?, tail?, sinceSeconds?, previous?}`.

| Parameter | Used by | What it does |
|---|---|---|
| `action` | all | `pods`, `rollout`, `logs`, `events` or `health` |
| `service` | all | A name from the catalog. An unknown name is refused with the names there are |
| `environment` | all | One of that service's environments. An unknown name is refused with the ones there are |
| `waitFor` | `rollout` | An image tag or version, exactly as `pods` shows it (1 to 128 characters of letters, digits, `. _ + -`). The call returns when every live pod is ready on it |
| `timeoutSec` | `rollout` | How long `waitFor` waits: 1 to 600, 300 by default. Only with `waitFor` |
| `pod` | `logs` | A pod of the service, as `pods` shows it. Default: the first ready pod. A pod that is not one of the service's is refused |
| `container` | `logs` | A container of the pod, an init container too. Default: the configured `container`, else the pod's only container, else the one named like the service, else kubectl's own default |
| `tail` | `logs` | Lines from the end: 1 to 2000, 200 by default |
| `sinceSeconds` | `logs` | Only lines from the last this many seconds: 1 to 86400 |
| `previous` | `logs` | The log of the container's previous run, which is how a crash is read |

`health` and `events` take nothing else: the address and the path are the
catalog's.

## What a result looks like

Plain text, short. `pods`:

```text
2 pods of orders-api in staging (namespace orders-staging):
- orders-api-0: 1/1 ready, Running, 0 restarts, 5m, image 1.4.3
- orders-api-1: 0/1 ready, CrashLoopBackOff, 7 restarts, 60m, image 1.4.2
```

`rollout` says what the workload and the pods show, in one of four words.
`Running` means as many pods as the workload wants, all ready, all on the version
(with no `waitFor`, all agreeing with each other). A pod that is being deleted
counts for nothing.

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

`events` keeps the namespace's events that are about the service's own pods,
deployments, statefulsets and the replica sets of a deployment (where "could not
create pod" is said): the latest 30, oldest first, with their age and how often
they happened. The cluster keeps events for about an hour, so a quiet service
has none.

```text
3 events about orders-api in staging (namespace orders-staging), oldest first, 2 warnings:
- 30m ago Warning FailedCreate ReplicaSet/orders-api-6d4f: exceeded quota
- 2m ago Warning BackOff Pod/orders-api-1: Back-off restarting failed container (x4)
- 60s ago Normal Pulled Pod/orders-api-0: Successfully pulled image
```

## Health

`health` has two forms, chosen by the catalog and not by the call.

**By address.** One `GET` on the environment's https `health` address. No
redirect is followed: a `302` comes back as a result that says where it points.
The service has ten seconds to answer. The result is the status and the first
4 KiB of the body, with terminal sequences and control characters taken out, and
a note when the body goes on. A status that is not 2xx is a result, not an error.
A request that gets no answer is an error that says why in this plugin's words
(the name does not resolve, the connection was refused, the certificate was not
accepted, no answer within 10 s) and is never repeated. The query of an address
is never put in a message, because it can hold a token. This works in production.

**Inside a pod.** When the environment has no address but a `healthPath`, a
`port` and a `container`, the tool runs `kubectl exec <pod> -c <container> --
curl -sS -m 20 -X GET -w "\n__status:%{http_code}" http://localhost:<port><path>`
in the first ready pod. The container must have `curl`; if it has none the tool
says so. The reply is capped at 2 MiB, and only the status and the body come
back. There is no method, header or body to give, so nothing goes on kubectl's or
curl's standard input. **It is refused when `jig-core` says the environment is
production**, whatever it is called, and a name `jig-core` does not know counts as
production. `classify` throws, so the call is blocked without asking anyone.

## The Kubernetes adapter

- **Reads only.** The kubectl commands the code can build are `get`, `logs` and,
  for the check inside a pod, `exec`. The two commands that change a cluster
  belong to the deploy tool (see [Deploy](deploy.md)). `delete`, `scale`,
  `apply`, `edit`, `rollout restart`, `port-forward`, `cp` and the rest are not
  refused at run time: they are not in the code, and tests ask for more than
  thirty of them. A rollout is read with `get`, not with `rollout status`.
- **One place builds kubectl.** `kubectl` is built and started only in
  `src/runtime/kubernetes/kubectl.ts`, from an argument list, never a shell,
  through `jig-core`'s `exec`. `jig-core` gives it a short environment; this
  plugin adds the path of the kubeconfig (`KUBECONFIG`) and nothing else.
- **The model names a service, not a cluster.** Every command starts with
  `--request-timeout`, `--context=` and `--namespace=` from the catalog, and
  `kubectl get pods` is given the selector. A call has no parameter for a
  context, a namespace, a selector, a flag or a verb. A `pod` or `container`
  that a call names must be one the cluster lists for the service, and the name
  that reaches kubectl is the listed one. A pod or a container whose name
  Kubernetes would not allow (one that could be read as a flag) is left out of
  what kubectl says.
- **Classification.** A call is a read in the `jig-core` environment that has the
  catalog's name for the environment. A production read is allowed and `jig-core`
  masks the result; this plugin masks nothing itself. The call's action is its
  `action`, so a rule such as `{ "tool": "runtime", "action": "events",
  "decision": "ask" }` covers one action.
- **Invalid input is not asked about.** An unknown service or environment, a
  parameter that breaks a limit, an environment with no Kubernetes runtime, and a
  health check in a pod where it is not allowed are blocked with a message that
  says what to change, and lists the names there are.
- **Waiting.** `rollout` with `waitFor` reads the pods and the workloads, then
  again after 2 seconds, then after each wait half as long again, never more than
  15 seconds apart, up to `timeoutSec` (at most 10 minutes). It looks one more
  time at the limit. It ends when the version runs, when a pod fails, or when
  time is up; the last two are results. A wait the user stops is an error that
  says the rollout itself is not affected.
- **Lines are data.** Terminal sequences and control characters are removed from
  log lines, event messages and bodies, so a hostile log cannot act on the
  terminal. `jig-core` masks production results, removes secrets, and cuts a long
  result with the whole text in a file.
- **Sign-in is the user's.** The tools never sign in. A kubeconfig that is
  expired, a network or VPN failure, a user who may not read: each is one line
  that says whose it is to fix, and nothing is retried by itself. A kubeconfig
  whose sign-in helper needs environment variables must set them itself (its
  `exec.env` field): `jig-core` does not pass Pi's environment on.
- **Facts.** After a call, its record carries a few numbers: for `pods` the pod
  count and how many are ready, for `rollout` the verdict, for `logs` the line
  count, for `events` the count and the warnings, for `health` the status.
