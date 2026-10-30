# jig-ops: build, deploy and run, on any CI and any platform

**Status: `runtime` and `deploy` are built; `ci` is planned.** Tested against a
fake `kubectl`, `helm` and `fetch` on this machine. Not tried against a real
cluster, Helm or health address yet (see [Not verified yet](docs/not-verified.md)).

`jig-ops` covers what happens after the code is written: can it go to a test
environment, is it healthy, and what do the logs say. You describe each service
once, in a **service catalog**, and the agent uses the same verbs whatever your
deploy method and platform are. For example, "deploy 1.4.3 of `orders-api` to
staging and check it": `deploy plan` shows what runs now and the exact command,
`deploy run` asks you with that as the preview, `deploy watch` waits for the
rollout, `runtime health` checks the health address, and `runtime events` and
`runtime logs` say why if it fails. `jig-core` governs every call.

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
| `ci` | The CI system and what to look at in it. Read and kept; nothing uses it until `ci` is built |
| `environments` | Per environment: how to `deploy` there (`helm` or `kubectl-image`), where it runs (`runtime.kubernetes`) and its `health` address. An environment without `deploy` cannot be deployed to by the agent |

`production` has no `deploy` on purpose: the agent never deploys to production.
An unknown field is an error, and the tools then do nothing until it is fixed
(`/jig` lists the problems). **An environment's name is also the name `jig-core`
knows it by,** and a name it does not know counts as production, so define your
test environments in `jig.json`. All fields: [The catalog](docs/catalog.md).

## Tools

### `runtime`

| Action | Kind | What it does |
|---|---|---|
| `pods` | read | A service's pods: ready, status, restarts, age, version |
| `rollout` | read | The workload behind them and a verdict: `Running`, `Still rolling`, `Failing`. With `waitFor` it waits for a version |
| `logs` | read | The last lines of one pod's log, or of its previous run |
| `events` | read | Recent events about the service's objects, such as failed scheduling or a killed container |
| `health` | read | A `GET` on the health address, or curl inside a pod where the catalog says so. Never in a production pod |

### `deploy`

| Action | Kind | What it does |
|---|---|---|
| `plan` | read | The versions running now, the one asked for, and the exact command |
| `run` | write in the environment | Deploys a version with the environment's method. Asks you, with the plan as the preview |
| `status` | read | The last deploy run from here, and the rollout |
| `rollback` | write in the environment | Back one revision, in a test environment only. Asks you, with the revision it goes back to |
| `watch` | local write | Waits in the background until every pod is ready on the version, a pod cannot come up, or time runs out |

### `ci` (planned)

Not built yet, and moving here from `jig-git`: `status`, `runs`, `run` and `log` as
reads, `rerun` and `trigger` as external writes, and `watch` for a run.

## Adapters

| Area | Built | Later, or added by anyone |
|---|---|---|
| CI | none yet | GitHub Actions, GitLab CI, Jenkins, Buildkite, CircleCI |
| Deploy | Helm, `kubectl set image` | A GitOps pull request, a CI deploy job, Argo CD, Flux, platform CLIs |
| Runtime | Kubernetes | Docker Compose, ECS, Cloud Run |

## Rules

- **Reads run.** Deploys and rollbacks in a test environment ask you. Writes to
  production are denied by the floor, and production reads are masked.
- **Arguments, never a shell.** `kubectl` and `helm` get their context, namespace,
  release, chart and values from the catalog, never from the model.
- **Four writes and no more:** `helm upgrade --install`, `helm rollback`,
  `kubectl set image` and `kubectl rollout undo`. No delete, scale, arbitrary exec
  or port-forward. The version is checked to be an image tag.
- **Never production.** A deploy or rollback there, and curl in a pod, is blocked
  before anyone is asked, by the kind `jig-core` gives the environment.
- **A preview is tied to the run.** If what runs now differs from what you
  approved, nothing is run: "changed since the preview".
- **No resend.** A command cut short, with an unknown outcome, is never run again:
  the rollout is read once and the result says so.
- **Credentials stay with you.** `kubectl` and `helm` use your kubeconfig and its
  sign-in; the tools never sign in.

## Company part (in the company plugin)

- its service catalog, and the test environments it adds to `jig-core`;
- later: its CI systems and deploy methods, and transports for systems only
  reachable through a bastion host, a VPN or a sign-in proxy.

## Later

- **`ci`,** with GitHub Actions, GitLab CI and Jenkins.
- **A GitOps pull request** as a deploy method, opened with `jig-git`'s tool, so
  `jig-core` still decides.
- **Docker Compose** for local stacks, with care: Docker access is root on the
  machine, so only the repository's compose files, with no host mounts.
- **Argo CD and Flux,** ECS and Cloud Run; **Terraform plan,** as a read.
- **One shared catalog** that `jig-logs`, `jig-http` and `jig-mongo` read too.

## Layout

```text
jig-ops/
  src/      index, catalog, watch (the ops-rollout kind), values; runtime/ (the tool, health by address,
            kubernetes/ the adapter); deploy/ (the tool, plans, actions, helm.ts and kubectl-image.ts)
  skills/   ops/SKILL.md: check the rollout, deploy to staging, watch, check health, read events and logs
  test/     against a fake kubectl and helm on a temporary PATH, a fake fetch and a fake jig-core
  docs/     the detail pages below
```

## More detail

- [The catalog](docs/catalog.md): every field, and what is checked
- [Runtime](docs/runtime.md): the parameters, the results, health, and the Kubernetes adapter's rules
- [Deploy](docs/deploy.md): the commands, previews, the fingerprint, no resend, rollback and watch
- [Not verified yet](docs/not-verified.md): what needs a real cluster, a real Helm or a real address
