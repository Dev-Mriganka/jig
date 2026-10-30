# Deploy: plans, previews, and why a command is never sent twice

What the `deploy` tool does, the exact commands it can start, and what it
promises when one goes wrong. Back to the [jig-ops overview](../README.md).

| Parameter | Used by | What it does |
|---|---|---|
| `action` | all | `plan`, `run`, `status`, `rollback` or `watch` |
| `service`, `environment` | all | Names from the [catalog](catalog.md), as for `runtime` |
| `version` | `plan`, `run`, `watch` | An image tag: 1 to 128 letters, digits, `.`, `_` and `-`, not starting with `.` or `-` |
| `timeoutMinutes` | `watch` | How long to watch: 1 to 120, 15 by default |

A call can name no release, chart, values file, value, image, context, namespace,
flag or verb: those are the catalog's. The version is the only text of a call that
reaches a command line, and it is checked to be an image tag. That is stricter
than what `runtime rollout` accepts to wait for, because this one is written into
a cluster: it can never be read as a flag, a digest or a second argument.

## The commands

The only writes this plugin can make are these four. Context, namespace, release,
chart, values and workload come from the catalog.

| Method | Deploys with | Goes back with |
|---|---|---|
| `helm` | `helm upgrade --install <release> <chart> --kube-context <context> --namespace <namespace> [--values <file>] [--set <key>=<value>]... --set image.tag=<version> --wait=false` | `helm rollback <release> --kube-context <context> --namespace <namespace>` |
| `kubectl-image` | `kubectl set image <workload> <container>=<image>:<version>`, with the context and namespace first | `kubectl rollout undo <workload>` |

- **The version is the last `--set`,** so nothing before it can win over it, and
  `image.tag` cannot be set in the catalog.
- **Only the tag changes with kubectl.** The image is read from the workload as it
  is now, its tag and digest are taken off, and the version is put on instead, so
  a deploy cannot move a service to another registry or repository.
- **No flag that skips a check, forces a change or waits.** `--wait=false` is the
  point: the deploy returns when the cluster has accepted it, and the rollout is
  watched separately.
- **Started from an argument list, never a shell,** through `jig-core`'s `exec`,
  with its short environment plus the path of the kubeconfig. A relative chart or
  values file is read from the folder Pi was started in.

The helm and kubectl commands that only read, to find the version a rollback goes
back to, are `helm history`, `helm get values` and `kubectl get`.

## Plan

`deploy plan` reads the rollout and says what runs now, what is asked for and the
command, and whether the version is already running. In an environment where the
agent does not deploy (production, or no method in the catalog) it says why a
`run` would be refused, and still says what runs. It asks nobody.

## Run and rollback: the preview and the run

Both are writes in the environment. By default `jig-core` asks the user, and the
floor denies a write to production. The screen it shows is the **preview**:

```text
Service:       orders-api
Environment:   staging (test)
Method:        helm
Running now:   1.4.2
Deploying:     1.4.3
Command:       helm upgrade --install orders-api deploy/chart --kube-context staging ...

The command runs once, without a shell. If it is cut short, whether it took effect is unknown, and it is not run again.
```

A rollback shows `Going back to: revision 4, which ran 1.4.2` instead.

**The fingerprint** is a digest of the service, the environment, the method, the
exact argument list, the versions running now and where the command goes. It
changes when the version asked for, the versions running, the command or the
service changes. It does not change when pods are scaled or become unready,
because those are not a change of version. When the user approves, the run plans
again with the cluster as it is, and **refuses with "changed since the preview"**
if the fingerprint differs, naming the versions that run now. Nothing is run.

**What the preview does not show** is the contents of the chart or the values
file: they are files on disk. A chart edited after the preview is not noticed.

### Where a rollback goes back to

- **Helm:** `helm history --max 2` gives the last two revisions, and `helm get
  values --revision <previous> --all` gives the previous one's `image.tag`. A
  release with one revision has nothing to go back to. A chart that does not take
  the version as `image.tag` shows `its version could not be read`.
- **kubectl:** the second newest revision, as `kubectl rollout undo` picks it: the
  replica sets of a deployment, numbered by an annotation, or the controller
  revisions of a statefulset. Only the objects the workload owns are read.

A rollback is for test environments only: `jig-core` must say the environment is
`test`, not `local` or `external`.

## No resend

A command is started **once**. It ends in one of three ways:

| It ended | What happens |
|---|---|
| It exited with `0` | The deploy is `started`. The model is told that nothing waits for the rollout |
| It exited with an error | The deploy `failed`, and the error is one line that says whose it is to fix (sign-in, network, a locked release, a missing release or chart). It is not retried |
| It was cut short | It ran longer than its limit (helm six minutes, which is longer than helm's own five for hooks; kubectl one minute), or the user cancelled the call while it ran |

A command that was cut short has an **unknown outcome**: it may have reached the
cluster. The tool then reads the rollout once, even if the call was cancelled, and
returns an error that shows what the cluster shows, says it was not run again, and
tells the model to check `deploy status` and the user before doing anything else.
A second deploy on top of an interrupted helm upgrade can leave a release locked.
A program that could not start (it is not installed) ran nothing, and says so.

## Status

`deploy status` says what the last deploy or rollback **run from here** did and
how it ended (`started`, `failed`, or cut short), and then the rollout, judged
against the version that deploy put on. The record is kept in memory for the
session: the cluster is the truth, and `status` always reads it. Every call is also
in `jig-core`'s records.

## Watch

`deploy watch` starts the `jig-core` watch kind **`ops-rollout`** and returns its id
at once. It is a write on this machine and changes no environment, so it asks
nobody; it also works for an environment the agent does not deploy to. The engine
polls it every 10 seconds, saves its state, and sends the agent one message:

| Outcome | When |
|---|---|
| `passed` | Every pod is ready on the version, and there are as many pods as the workloads want |
| `failed` | A pod waits for a reason that does not pass by itself (`CrashLoopBackOff`, `ImagePullBackOff`, ...) |
| `timed-out` | The deadline came. The message says how far the rollout got and how long it waited |

The saved spec holds the service, the environment and the version, never a context
or a namespace: every poll finds them in the catalog as it is then. The watch's own
deadline is five seconds before the engine's, so the last poll is the kind's and
can say how far the rollout got. A watch for the same rollout that is already open
is returned, not started twice. A poll that cannot read the cluster is a failed
poll, which the engine counts: three in a row pause the watch with a notice.
