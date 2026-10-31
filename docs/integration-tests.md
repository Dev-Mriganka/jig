# Integration tests

The unit tests run the plugins against fakes. The integration tests run the same plugin code against real services,
such as Elasticsearch, MongoDB and Kubernetes, so a fake that is wrong about the real thing cannot hide a bug.

## What runs where

| | Unit tests | Integration tests |
|---|---|---|
| Command | `npm test` | `npm run test:it` |
| Files | `plugins/*/test/*.test.ts` | `plugins/*/test/it/*.test.ts` |
| Talks to | fakes on `127.0.0.1` | real services |
| Runs in CI | the `checks` job | the `integration` job |

- **In CI,** the `integration` job of `.github/workflows/ci.yml` starts the services as containers from
  [`.github/integration/compose.yml`](../.github/integration/compose.yml), a `kind` cluster for `jig-ops`, and runs
  `npm run test:it` against them. It runs twice, on the latest line of the services and on the previous one (see
  [The matrix](#the-matrix)), on every push to `main` and on every pull request.
- **On your machine,** a suite runs when the environment variables that hold its service's address are set, and is
  skipped, naming them, when they are not. With nothing set, `npm run test:it` skips everything and passes.
- **In CI, a missing service fails.** The workflow sets `JIG_IT_REQUIRE` to the services it starts, so a service that did
  not start fails its suite and cannot make it skip.

## Secrets

No secret is needed. Every credential in a test is a throwaway value, either set in the workflow or made when the
test runs, and none is shaped like a real token (see [AGENTS.md](../AGENTS.md)). The one token is the `GITHUB_TOKEN`
that Actions gives each run, which the workflow hands to `gh` as `GH_TOKEN`. The job's `permissions` make it read only: it reads this
repository's workflow runs and public repositories.

## How a suite is written

A suite uses `describeIt` from `test/support/it.ts`. It names the service and the variables that hold its address:

```ts
describeIt("jig-logs against Elasticsearch", { service: "elasticsearch", variables: ["JIG_IT_ELASTICSEARCH_URL"], hint: "a throwaway Elasticsearch 8 or 9" }, () => {
    // runs only when the variables are set; read them with must("JIG_IT_ELASTICSEARCH_URL")
});
```

- **The plugin's real code** runs: its tool, its configuration check, and `jig-core`'s request code (`kit/http.ts`,
  the OAuth code). Only Pi's screen and the parts of `jig-core` that need a session are replaced by the fakes the
  other tests of that plugin use.
- **Every suite makes its own data,** with names that include a random part, and removes it at the end, so two runs
  against one service do not meet.

## What only CI runs

- **A kind cluster.** `cluster.test.ts` needs a node that runs pods, for `logs`, `exec`, and the events a kubelet writes. The `deploy`
  and `runtime` flows without those were also run here against a bare control plane (see the `jig-ops` section).
- **Names that only a Docker network resolves.** The replica set's members are `mongo1` to `mongo3` there, so the check that this machine
  cannot reach them without the tunnel skips anywhere else.
- **An ssh key GitHub does not know.** `clone` over ssh to a repository a key can read was run once by hand; CI runs the refusal.

## The matrix

The `checks` job runs on the current Node LTS line and the previous one. The `integration` job has two entries, and each
moves several versions together, so the lines that users run side by side are all tried without a run for every combination.

| | Latest line | Previous line |
|---|---|---|
| Node | 26 (LTS since 2026-10-28) | 24 |
| Elasticsearch | 9.5.5 | 8.19.23 |
| OpenSearch | 3.9.0 | 2.19.7 |
| MongoDB | 9.0.4 | 8.0.34 |
| Helm | 4.3.1 | 3.22.1 |

- **The same on both:** Grafana Loki 3.7.9, go-httpbin 2.26.0, Keycloak 26.8.1, OpenSSH 10.3 (the jump host), kind v0.33.0 with
  Kubernetes 1.37.0 nodes and kubectl 1.37.2, and Pi 1.4.0. Loki, Keycloak and the rest have no older line that the plugins claim.
- **Pi is installed at an exact version,** the latest one, because the type check and the `jig-agents` tests read its own packages.
  When Pi releases, change the version in `ci.yml` and `AGENTS.md` together.
- **The `checks` job** runs both Node lines, and prints `node --version` first. Node 22.19, the lowest that `package.json` allows,
  is not run in CI.
- **Not crossed.** Node is not crossed with the services: Node differences show in the unit tests of the `checks` job, and the
  services differ from each other whatever the Node line. A failure that needs one combination is reproduced by hand.

## MongoDB and the kernel

MongoDB 8.x and 9.x run on every member with `GLIBC_TUNABLES=glibc.pthread.rseq=1`. Without it the server may exit at start-up
on GitHub's runners.

- **The cause.** `mongod` stops with "Linux kernel versions 6.19 and newer has a known incompatibility" when TCMalloc runs on per-CPU caches
  and the kernel is 6.19 through 7.0.13 (`validateRseqKernelCompat`). The official image turns those caches on with
  `GLIBC_TUNABLES=glibc.pthread.rseq=0`.
- **The setting.** `glibc.pthread.rseq=1` in the service's environment makes TCMalloc use per-thread caches, which the start-up
  check accepts on every kernel. It is set on `mongo1` to `mongo3` in `compose.yml`.
- **Why not a newer image.** The upstream fix (SERVER-125742, in 8.0.30, 8.3.9, 9.0 and later) only lifts the check on kernels
  7.0.14 and later. Ubuntu reports every 7.0 kernel as `7.0.0-N`, so an Ubuntu runner never passes it, and the setting is what works. The
  analysis is in [swarmcli-charts#311](https://github.com/Eldara-Tech/swarmcli-charts/pull/311).
- **It is asserted.** The set-up step reads `db.serverStatus().tcmalloc.usingPerCPUCaches` from each member and fails unless it
  is `false`, so an image that ignores the setting fails the job with that reason and not by a start-up crash.
- **The cost** is TCMalloc without per-CPU caches, which is slower for the allocator and does not matter for tests.

Before this setting the job ran MongoDB 7.0, the one line that starts on every kernel.

## Pinned versions

Every image has an exact version tag and its digest, and every action a commit SHA with its version in a comment. To update
one, change the tag and the digest together, then read the run.

- **The images are in `.github/integration/`.** `compose.yml` holds the latest line and `previous/compose.yml` replaces only the images
  that have a previous line. The Kubernetes node image is a `kind-node` service that is never started, so that Dependabot's
  `docker-compose` support tracks it too; the workflow reads its `image:` and hands it to `kind`.
- **Dependabot has two entries for them.** One for `.github/integration`, and one for `.github/integration/previous` that ignores
  new majors (and, for MongoDB, new minors) so that the previous line stays the previous line.
- **Not tracked by Dependabot:** the versions given to actions as inputs, which are Helm, kind and kubectl in `ci.yml`, and the
  Pi version. Read them when you update an image.
- **Actions** are tracked by Dependabot's `github-actions` entry, and kept at the latest release.

## Running one on your machine

Start the service, set the variables that its section below lists, and run the file. To start all of them as CI does, with Docker:

```bash
eval "$(.github/integration/prepare.sh /tmp/jigit shell)"
export JIG_IT_ELASTICSEARCH_PASSWORD=throwaway JIG_IT_MONGO_PASSWORD=throwaway
docker compose -f .github/integration/compose.yml up -d elasticsearch opensearch loki loki-limited
```

Add `-f .github/integration/previous/compose.yml` after the first file for the previous line, and see the workflow for the replica
set's set-up. Or start one service and run its file:

```bash
JIG_IT_LOKI_URL=http://127.0.0.1:3100 JIG_IT_LOKI_LIMITED_URL=http://127.0.0.1:3101 \
  node --import ./test/support/host.mjs --test plugins/jig-logs/test/it/loki.test.ts
```

Without Docker, the services run from their own release archives as well: the tests only need the address.

## jig-logs

Three suites, `elasticsearch.test.ts`, `opensearch.test.ts` and `loki.test.ts`. They share `suite.ts`, so the same
expectations hold for every backend, and they seed their own data (`test/support/dataset.ts`) at known times a few hours back.

| Variable | What it holds |
|---|---|
| `JIG_IT_ELASTICSEARCH_URL` | `https://127.0.0.1:9200`: Elasticsearch 8 or 9 with security on |
| `JIG_IT_ELASTICSEARCH_PASSWORD` | The password of its `elastic` user, which the tests use to make their own users |
| `NODE_EXTRA_CA_CERTS` | The node's certificate authority file, `config/certs/http_ca.crt` in the container |
| `JIG_IT_OPENSEARCH_URL` | `http://127.0.0.1:9201`: OpenSearch 2 or 3 with its security plugin off |
| `JIG_IT_LOKI_URL` | `http://127.0.0.1:3100`: Loki 3 with tenants on |
| `JIG_IT_LOKI_LIMITED_URL` | `http://127.0.0.1:3101`: a second Loki with tight limits |

- **Elasticsearch** runs with `ELASTIC_PASSWORD` set, which turns security on with HTTPS. The workflow copies the
  certificate authority out of the container and sets `NODE_EXTRA_CA_CERTS` for the test step.
- **OpenSearch** runs with `DISABLE_SECURITY_PLUGIN=true`. It speaks plain HTTP, so the tests reach it through a
  transport, which is the path a company's gateway takes.
- **Loki** runs with `-auth.enabled=true`, and the tests send the tenant `jig-it`. Both nodes also get
  `-ingester.query-store-max-look-back-period=168h -querier.query-ingesters-within=200h`, because Loki otherwise answers
  only for the last three hours and the tests search windows of days. The limited node adds `-store.max-query-length=20m
  -validation.max-entries-limit=150`.

## jig-mongo

Three suites: `mongo.test.ts` (direct), `ssh.test.ts` (the SSH route) and `tunnel.test.ts` (a SOCKS tunnel to the replica set).
Each makes a database of its own and drops it at the end.

Production reads go through the [index check](../plugins/jig-mongo/docs/index-check.md), which is on for production by default, so
the seed makes the indexes the reads need and the real planner decides. One test shows a `COLLSCAN` refused and an indexed read
allowed. `requireIndex: false` is set on one extra connection only, to show that the switch works; no other test turns the check off.

| Variable | What it holds |
|---|---|
| `JIG_IT_MONGO_DIRECT_URI` | A member that the test host can reach, with `directConnection=true` |
| `JIG_IT_MONGO_REPLICA_URI` | The replica set's own address, with member names that only the jump host can look up |
| `JIG_IT_MONGO_SSH_URI` | One member as the jump host names it, for the SSH forward |
| `JIG_IT_MONGO_USER`, `JIG_IT_MONGO_READONLY_USER` | A user that reads and writes, and one that only reads |
| `JIG_IT_MONGO_PASSWORD` | The password of both |
| `JIG_IT_SSH_HOST`, `JIG_IT_SSH_PORT`, `JIG_IT_SSH_USER` | The jump host |
| `JIG_IT_SSH_KEY_FILE` | The private key of that user, an unencrypted file |
| `JIG_IT_MONGO_MEMBERS_HIDDEN` | Set it when this machine cannot look up the members; the check for that then must not skip |

- **The replica set** is MongoDB 9.0, or 8.0 in the previous line, with the start-up setting that
  [MongoDB and the kernel](#mongodb-and-the-kernel) explains. It has three members with a key file and authentication, named `mongo1` to `mongo3` on a Docker network. The
  official image makes the root user when it starts, the workflow starts the set, and `agent` and `agent-readonly` are made with
  `readWriteAnyDatabase`, `dbAdminAnyDatabase` and `clusterMonitor`, and with `readAnyDatabase`.
- **The jump host** is an OpenSSH server in a container on that network, with TCP forwarding switched on and the workflow's
  throwaway key as the only one that signs in. It is how the tests reach `mongo1` to `mongo3` by name: the test host cannot look
  them up, so a tunnel that does not work cannot pass.
  - **Its settings** come from a drop-in the workflow writes: forwarding on, `LogLevel VERBOSE`, a higher `MaxStartups` for suites that
    connect together, and `PerSourcePenalties no`.
  - **Why the penalties are off.** OpenSSH 9.8 and later drop all connections from an address after a few failed sign-ins, and some
    tests fail to sign in on purpose, so the tests that ran after them found the door shut. The job prints the settings sshd settled on.
  - **Its log** goes to the container's output (`LOG_STDOUT=true`), where the "Service logs" step of a failed job prints it.
- **The SSH route** (`ssh.test.ts`) uses an `ssh` that is the real one with a known_hosts file of the test's making, because the tool
  starts `ssh -F /dev/null` and so would read your own `~/.ssh/known_hosts`.
- **The SOCKS tunnel** (`tunnel.test.ts`) is opened by a provider the test registers with `jig-core`, as a company plugin would,
  with `ssh -N -D`. The production read from a secondary is proved by asking each member how many reads of the collection it
  served.
- **Without Docker,** a replica set of three local `mongod` processes works: start them without `--keyFile` to make the root user,
  then with `--replSet` and `--keyFile`, and use member addresses such as `127.0.0.1:27117`. The test that the members cannot be
  looked up skips, because `127.0.0.1` can.

## jig-ops

Three suites: `cluster.test.ts` (`deploy` and `runtime` against Kubernetes and Helm), `github.test.ts` (the `ci` tool's GitHub Actions
adapter) and `health.test.ts` (health by address). The last needs only `openssl`.

| Variable | What it holds |
|---|---|
| `JIG_IT_KUBE_CONTEXT` | The kubectl context of a cluster the test may create a namespace in |
| `GH_TOKEN` | A token `gh` signs in with. Without it, `gh` uses its own login |
| `JIG_IT_GITHUB_REPOSITORY` | `owner/name` of the repository whose workflow runs are read |
| `JIG_IT_GITHUB_RUN_ID` | The id of one of its runs |
| `JIG_IT_GITHUB_WORKFLOW` | Optional: the workflow file, `ci.yml` by default |

- **The cluster** is made by `helm/kind-action` from a pinned kind release and the node image of `compose.yml`, and Helm (4 in the latest
  line, 3 in the previous) by `azure/setup-helm`. The workflow names the context `kind-jigit`.
- **The chart** is `plugins/jig-ops/test/it/chart`: an unprivileged nginx whose images are pinned by tag and digest. The test makes a
  namespace of its own and deletes it at the end.
- **The tests run in order,** each from what the one before left in the cluster: install, read, replace a pod, upgrade, roll back, be
  refused after another deploy, break on purpose with a tag that does not exist, and recover.
- **GitHub Actions** is read with the token the run gets. The job's `permissions` are `contents`, `actions`, `checks` and `statuses`, all
  `read`, so nothing here can write. The run that reads is itself in progress, so it is the run the test looks at.
- **Without Docker,** the `deploy` and `runtime` flows can be tried against a control plane made of `etcd`, `kube-apiserver`,
  `kube-controller-manager` and `kube-scheduler` with a node object and a small program that marks scheduled pods ready. Pods then never
  start, so `logs`, `exec` and the kubelet's events cannot be read there.

## jig-git

One file, `github.test.ts`, with two suites. They only read, and nothing is pushed, created or commented.

| Variable | What it holds |
|---|---|
| `JIG_IT_GITHUB` | Any value: this machine may reach github.com |
| `GH_TOKEN` | A token `gh` signs in with. Without it, `gh` uses its own login |

- **Git over https** clones `actions/hello-world-docker-action` with plain git, because the plugin's `clone` goes over ssh and a run has no
  key GitHub knows. The plugin then fetches, logs and reads that clone, and reads its tags. Its own `clone` is tried with an ssh that has no
  key, and must fail in one line and leave nothing behind.
- **Pull requests and releases** are read through `gh` for `cli/cli`, with a repository that holds nothing but an `origin`, and for the
  small repository. A run gets this by the token of `permissions`; on your machine `gh`'s own login does the same.

## jig-api

Two suites. `httpbin.test.ts` copies the example company's collections (Postman, `.http`, Bruno in both formats, OpenAPI in both) with their
API address pointed at httpbin's `/anything`, which echoes the request, and runs them by name. `keycloak.test.ts` signs in with OAuth.

| Variable | What it holds |
|---|---|
| `JIG_IT_HTTPBIN_URL` | `http://127.0.0.1:8081`: go-httpbin with `MAX_BODY_SIZE=8388608` |
| `JIG_IT_KEYCLOAK_URL` | `http://127.0.0.1:8180`: Keycloak in dev mode, with the realm of `plugins/jig-api/test/it/keycloak/realm.json` imported |

- **The realm** has a service client (`jig-service`, client credentials), a portal client (`jig-portal`, password grant) and one user. The
  tests read their secrets from that file, so the file is the one place they are written, and all are throwaway values.
- **Without Docker,** go-httpbin and Keycloak run from their release archives (Keycloak needs Java 21): `go-httpbin -port 8081
  -max-body-size 8388608`, and `kc.sh start-dev --http-port=8180 --import-realm` with the realm file in `data/import`.

## Where to read a failure

The job prints the versions of Node, Docker and Compose and the image of every service before it starts them, and each service's
version once it is up. When a step fails, the last step prints the logs of every container, each in its own group. A failed test names the backend, and its message shows the text the tool returned.
