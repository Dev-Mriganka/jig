# jig-k8s: Kubernetes reads

**Status: design.**

## Tool: `k8s`

All actions are reads.

| Action | What it does |
|---|---|
| `pods` | A service's pods: ready, status, restarts, age, image tag |
| `status` | The deployment or statefulset behind the pods: ready replicas, revision, image. It can optionally wait until a given version is running |
| `logs` | The last lines of a pod's log |
| `api` | A `GET` on the service's admin API from inside a ready pod. Test environments only |

Restarts and scaling are not part of this plugin.

## Rules

- `kubectl` is built and run only here, with arguments, never a shell.

## Company part (in the company plugin)

- the services table: for each service and environment, the cluster context,
  the namespace and the pod selector.

## Layout (planned)

```text
jig-k8s/
  src/      the tool and the kubectl command builder
  test/     with a fake kubectl
```
