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
| `ci` | The CI system and where it is. An object with a `system` and the fields of that system: see [`ci`](#ci) below |
| `environments` | A map from an environment name to its entry: 1 to 20 per service. A name has letters, digits, `_` and `-`, starts with a letter, and has up to 40 characters |

A section may also have `watch` and `artifacts`, which are not about one service: see
[Watching CI](#watching-ci).

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

## `ci`

An object with a `system`, one of `github-actions`, `gitlab` and `jenkins`, and the
fields of that system. An unknown system or field is an error that names it. What
the tool does with them is in [CI](ci.md).

| System | Field | Meaning |
|---|---|---|
| any | `environment` | Optional. The `jig-core` environment the CI server is in. Without it, the CI host is `external`. A name `jig-core` does not know counts as production |
| `github-actions` | `workflow` | Optional. The workflow file whose runs `runs` lists, such as `build.yml` |
| | | The service needs `repo`, of the form `owner/name`: the run is found by repository |
| `gitlab` | `url` | The address of the server, `https`, with no user name, query or fragment. It may have a path (`https://host/gitlab`) |
| | `project` | A project id, or the path with its namespace, such as `acme/orders-api` |
| | `auth` | One of `{ "token": "<secret reference>" }`, `{ "signIn": "<service>" }` and `{ "transport": "<name>" }` |
| | `required` | Optional. Up to 20 job names that a `required` watch waits for |
| `jenkins` | `url` | As for GitLab |
| | `job` | The job with its folders, such as `orders/build`. A name may hold a space |
| | `auth` | One of `{ "user": "<name>", "token": "<secret reference>" }`, `{ "signIn": "<service>" }` and `{ "transport": "<name>" }` |
| | `required` | Optional. Up to 20 pipeline stage names that a `required` watch waits for |

A token is a secret reference such as `pass:ci/gitlab`; one pasted by hand is an
error that never repeats it. With a transport, the address may be plain `http`:
the transport signs in, so no credential travels.

## Watching CI

The `watch` and `artifacts` parts of the section were `git.watch` and
`git.artifacts` while `jig-git` ran the watch. All fields are optional.

| Field | Default | Meaning |
|---|---|---|
| `watch.auto` | `true` | Start a watch after a push and after a pull request is created |
| `watch.pollSeconds` | 30 | Poll every 5 to 3600 seconds, at least; a CI system can ask for longer |
| `watch.stallMinutes` | 30 | A "still waiting" notice after 1 to 1440 minutes |
| `watch.timeoutMinutes` | 60 | Give up after 1 to 1440 minutes |
| `artifacts` | none | The "artifact ready" rules. Each has a `kind` (`image`, `tag` or `release`) and exactly one place to look: `check` (a job name, with an optional `log` pattern), `comment` (a pattern, with an optional `bot` login) or `tag` (a name pattern) |

```json
{
  "ops": {
    "services": {
      "orders-api": {
        "repo": "acme/orders-api",
        "ci": {
          "system": "gitlab", "url": "https://gitlab.example.com", "project": "acme/orders-api",
          "auth": { "token": "pass:ci/gitlab" }, "required": ["build", "test"]
        },
        "environments": { "staging": { "health": "https://api.staging.example.com/orders/health" } }
      }
    },
    "watch": { "pollSeconds": 20 },
    "artifacts": [{ "kind": "image", "check": "build-image", "log": "image: (\\S+)" }]
  }
}
```

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
