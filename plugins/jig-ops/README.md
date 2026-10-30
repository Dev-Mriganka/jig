# jig-ops: build, deploy and run, on any CI and any platform

**Status: design.** The Kubernetes reads are being built and become this
plugin's first runtime adapter. CI moves here from `jig-git`.

`jig-ops` covers what happens after the code is written: did it build, can it
go to a test environment, is it healthy, and what do the logs say. You
describe each service once, in a **service catalog**, and the agent then uses
the same verbs whatever your CI system, deploy method and platform are. For
example, "deploy the build of my branch to staging and check it": the agent
finds the CI run for the commit, deploys its image with the service's deploy
method (asking you first), waits for the rollout, checks the health address,
and reads the pods' logs if anything fails.

## The service catalog

In `~/.pi/agent/jig.json`, under `ops`:

```json
{
  "ops": {
    "services": {
      "orders-api": {
        "repo": "acme/orders-api",
        "ci": { "system": "github-actions", "workflow": "build.yml" },
        "environments": {
          "staging": {
            "deploy":  { "method": "helm", "release": "orders-api", "chart": "deploy/chart" },
            "runtime": { "kubernetes": { "context": "staging", "namespace": "orders", "selector": "app=orders-api" } },
            "health":  "https://api.staging.example.com/orders/health"
          },
          "production": {
            "runtime": { "kubernetes": { "context": "prod", "namespace": "orders", "selector": "app=orders-api" } }
          }
        }
      }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `repo` | Where the code lives, for finding the CI run of a commit |
| `ci` | The CI system and what to look at in it, such as a workflow, a project or a job |
| `environments` | Per environment: how to `deploy` there, where it runs (`runtime`) and its `health` address. An environment without `deploy` cannot be deployed to by the agent |

`production` has no `deploy` on purpose: the agent never deploys to
production. The floor denies it anyway.

## Tools

### `ci`

| Action | Kind | What it does |
|---|---|---|
| `status` | read | The CI state of a commit, branch or pull request |
| `runs`, `run` | read | Recent runs, and one run's jobs and steps |
| `log` | read | A failed job's log: the tail, or the lines matching a search |
| `rerun` | external write | The failed jobs, or the whole run |
| `trigger` | external write | Starts a pipeline or job with parameters, such as a build of a branch |
| `watch` | local write | Waits in the background until a run finishes, on `jig-core`'s watch engine |

### `deploy`

| Action | Kind | What it does |
|---|---|---|
| `plan` | read | What a deploy would change: the version running now, and the one that would replace it |
| `run` | write in the environment | Deploys a version of a service with its deploy method. Asks you, with the plan as the preview |
| `status` | read | The last deploy and whether its rollout finished |
| `rollback` | write in the environment | Back to the previous version, in a test environment only |
| `watch` | local write | Waits in the background until the rollout is healthy, or has failed |

### `runtime`

| Action | Kind | What it does |
|---|---|---|
| `pods` | read | A service's instances: ready, status, restarts, age, version |
| `rollout` | read | The rollout behind them: ready replicas, revision, image |
| `logs` | read | The last lines of one instance's log |
| `events` | read | Recent platform events, such as failed scheduling or crashes |
| `health` | read | A GET on the service's health address |

## Adapters

Every system speaks the same verbs; only a small adapter differs.

| Area | First adapters | Later, or added by anyone |
|---|---|---|
| CI | GitHub Actions, GitLab CI, Jenkins | Buildkite, CircleCI, others |
| Deploy | Helm, `kubectl set image`, a GitOps pull request, a CI deploy job | Argo CD, Flux, platform CLIs |
| Runtime | Kubernetes | Docker Compose, ECS, Cloud Run |

A pull request's checks already gather most CI systems' results on GitHub, so
`ci status` for a pull request works with any CI from the start.

## Rules

- **Reads run.** Deploys, rollbacks, reruns and triggers in a test environment
  ask you, unless your rule allows them. Writes to production are denied by
  the floor, and production reads are masked.
- **Arguments, never a shell.** `kubectl`, `helm` and the CI clients get their
  context, namespace, release and project from the catalog, never from the
  model.
- **Nothing destructive.** No delete, scale, arbitrary exec or port-forward.
  Rollback only in a test environment.
- **GitOps goes through `jig-git`.** That adapter opens its pull request with
  `jig-git`'s tool, so `jig-core` still decides.
- **Credentials stay with the tool:** CI tokens are secret references, or a
  company sign-in service or transport.

## Company part (in the company plugin)

- its service catalog;
- its CI systems and deploy methods, with their settings;
- transports for systems only reachable through a bastion host, a VPN or a
  sign-in proxy.

## Later

- **Docker Compose** for local stacks, designed with care: access to Docker is
  root on the machine, so only the repository's compose files, with no host
  mounts.
- **Argo CD and Flux,** ECS and Cloud Run.
- **Terraform plan,** as a read.
- **One shared catalog** that `jig-logs`, `jig-api` and `jig-mongo` read too, so
  a service is described once.

## Layout (planned)

```text
jig-ops/
  src/      catalog, ci/ (one file per adapter), deploy/ (one per adapter), runtime/ (one per adapter), watch kinds
  skills/   ops/SKILL.md: build, deploy to staging, verify, then read logs
  test/
```
