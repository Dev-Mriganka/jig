# Not verified yet

What the tests of `jig-ops` do not cover. Back to the [jig-ops overview](../README.md).

Written from the Kubernetes and Helm documentation, from the behaviour of the
programs as an earlier harness met them, and against a fake `kubectl`, a fake
`helm` and a fake `fetch` on this machine. Nothing here has been tried against a
real cluster, a real Helm or a real health address.

## Helm

- **The shape of `helm history --max 2 -o json`** (the latest two revisions,
  oldest first, each with a `revision` number) and of `helm get values --revision
  N --all -o json` (a chart's defaults and the user's values merged, with the
  version under `image.tag`). A rollback's "going back to" line relies on both.
- **`helm upgrade --install ... --wait=false` with hooks.** Helm waits for
  hooks, such as a pre-upgrade migration job, for up to five minutes even without
  `--wait`. The tool allows six, so that it is helm that gives up and not this
  plugin that stops it. A helm that is stopped part way can leave a release in
  `pending-upgrade`; the tool treats that as an unknown outcome and says that a
  locked release is the user's to look at.
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
