# The service catalog

Every field of the `ops` section of `~/.pi/agent/jig.json`, and what is checked.
Back to the [jig-ops overview](../README.md).

`jig-core` checks the section when a session starts. An unknown field is an
error, and so is a field with a value it cannot use. Each error names its key
(`ops.services.orders-api.environments.staging.deploy.release`) and never
repeats the value it refused, because a secret pasted into the wrong place must
not reach the model. While the section has an error, the tools say `ops is not
set up` and do nothing; `/jig` lists the problems.

## Services and environments

| Field | Meaning |
|---|---|
| `services` | A map from a service name to its entry: 1 to 100 services. A name has 1 to 40 letters, digits, `.`, `_` and `-`, and starts with a letter or a digit |
| `repo` | Where the code lives, such as `acme/orders-api`: text of up to 200 characters with no white space |
| `ci` | The CI system and what to look at in it. An object with a `system` (a lower-case name such as `github-actions`) and other text fields, such as `workflow`. It is read and kept, and nothing uses it until the `ci` tool exists |
| `environments` | A map from an environment name to its entry: 1 to 20 per service. A name has letters, digits, `_` and `-`, starts with a letter, and has up to 40 characters |

An environment has `deploy`, `runtime` and `health`, and at least one of them.

**An environment's name is the name `jig-core` knows it by.** The rules, the
masking and the kind of environment (local, external, test or production) come
from that name, so there is no second mapping to keep. Define the test
environments in `jig.json`:

```json
{ "environments": { "staging": { "kind": "test" } } }
```

A name `jig-core` does not know counts as production. Deploys and rollbacks
there are refused, a health check in a pod is refused, and results are masked.
If a test environment is refused as production, this is the setting to add.

## `deploy`

An object with a `method`. An environment without `deploy` cannot be deployed
to by the agent, and `production` has none on purpose. Both methods deploy to a
cluster, so the environment must also have `runtime.kubernetes`, which gives the
context and the namespace.

| Method | Field | Meaning |
|---|---|---|
| `helm` | `release` | The Helm release name: lower-case letters, digits and `-`, up to 53 characters |
| | `chart` | A folder, a chart of a repository such as `acme/orders-api`, or an OCI address. Up to 300 characters, no white space, not starting with `-` |
| | `valuesFile` | Optional. A values file, with the same rules as `chart` |
| | `set` | Optional. Up to 20 Helm values, such as `{ "replicaCount": 2 }`. A value is a number, a boolean or text of letters, digits and `. _ : / @ + % ~ = -`, up to 200 characters, so that helm cannot read a comma or a brace in it. `image.tag` is not allowed: the deploy sets it from the version |
| `kubectl-image` | `workload` | `deployment/<name>` or `statefulset/<name>` |
| | `container` | The container of that workload whose image tag changes |

The chart must take the version as `image.tag`. A relative `chart` or
`valuesFile` is read from the folder Pi was started in; give an absolute path for
another. The commands that are built from these fields are in
[Deploy](deploy.md#the-commands).

## `runtime`

An object that names a runtime. Kubernetes is the only one so far, as
`runtime.kubernetes`:

| Field | Meaning |
|---|---|
| `context` | The kubectl context, as `kubectl config get-contexts` shows it. A cloud context may hold `:` and `/`; none may start with `-` |
| `namespace` | The namespace the service runs in |
| `selector` | The label selector of the service's pods: one to ten `key=value` pairs, comma separated, equality only, such as `app=orders-api`. The deployments and statefulsets behind the pods are the ones whose selector or pod template carries these labels |
| `container` | Optional. The service's own container: the one `logs` reads when a call names none, the one whose image tag is the version, and the one a health check runs curl in. Without it, it is the pod's only container, or the one named like the service by its name or its image |
| `healthPath`, `port` | Optional, and together with `container`. The path (with an optional query) and the port of a health check made inside a pod, such as `/actuator/health` and `8080`. The path starts with `/`, has up to 400 characters of the usual set, and no `..`, however it is percent-encoded |

`healthPath`, `port` and `container` go together: one of them alone is an error,
because the check could never run.

## `health`

An https address that answers when the service is healthy, such as
`https://api.staging.example.com/orders/health`. No user name, password or
fragment, and up to 500 characters. Plain `http` is not accepted, and
certificates are always checked: to trust a private certificate authority, start
Pi with `NODE_EXTRA_CA_CERTS` pointing at its certificate.

When an environment has both a `health` address and a health path in a pod,
`runtime health` uses the address. A check in a pod is for test environments
that have no address.

## Examples

A service deployed with Helm, with a values file and a value, whose health is
checked by address in staging and read in production:

```json
{
  "ops": {
    "services": {
      "orders-api": {
        "environments": {
          "staging": {
            "deploy": {
              "method": "helm", "release": "orders-api", "chart": "deploy/chart",
              "valuesFile": "deploy/values-staging.yaml", "set": { "replicaCount": 2 }
            },
            "runtime": { "kubernetes": { "context": "staging", "namespace": "orders", "selector": "app=orders-api" } },
            "health": "https://api.staging.example.com/orders/health"
          },
          "production": {
            "runtime": { "kubernetes": { "context": "prod", "namespace": "orders", "selector": "app=orders-api" } },
            "health": "https://api.example.com/orders/health"
          }
        }
      }
    }
  }
}
```

A service whose image is set with `kubectl`, and whose health is checked with
curl inside its pod (one entry of `services`):

```json
{
  "billing": {
    "environments": {
      "staging": {
        "deploy": { "method": "kubectl-image", "workload": "deployment/billing", "container": "billing" },
        "runtime": {
          "kubernetes": {
            "context": "staging", "namespace": "billing", "selector": "app=billing",
            "container": "billing", "port": 8080, "healthPath": "/actuator/health"
          }
        }
      }
    }
  }
}
```
