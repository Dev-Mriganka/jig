# jig-k8s: Kubernetes reads

**Status: design.**

`jig-k8s` lets the agent look at what runs in a cluster: a service's pods, the
rollout behind them, and their logs. Every action is a read, and it never uses
a shell. For example, `k8s pods` for `orders-api` in `staging` shows each pod's
readiness, restarts and image tag, and `k8s status` can wait until a given
version is running.

## Tool: `k8s`

All actions are reads.

| Action | Kind | What it does |
|---|---|---|
| `pods` | read | A service's pods: ready, status, restarts, age, image tag |
| `status` | read | The deployment or statefulset behind the pods: ready replicas, revision, image. It can optionally wait until a given version is running |
| `logs` | read | The last lines of a pod's log |
| `api` | read | A `GET` on the service's health or info endpoint from inside a ready pod. Test environments only |

Restarts and scaling are not part of this plugin.

## Rules

- **`kubectl` is built and run only here,** with arguments, never a shell.

## Company part (in the company plugin)

- the service map: for each service and environment, the cluster context, the
  namespace and the pod selector.

## Layout (planned)

```text
jig-k8s/
  src/      the tool and the kubectl command builder
  test/     with a fake kubectl
```
