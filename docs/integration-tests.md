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

- **In CI,** the `integration` job of `.github/workflows/ci.yml` starts the services as containers, a `kind` cluster for
  `jig-ops`, and runs `npm run test:it` against them. It runs on every push to `main` and on every pull request.
- **On your machine,** a suite runs when the environment variables that hold its service's address are set, and is
  skipped, naming them, when they are not. With nothing set, `npm run test:it` skips everything and passes.
- **In CI, a missing service fails.** The workflow sets `JIG_IT_REQUIRE` to the services it starts, so a service that did
  not start fails its suite and cannot make it skip.

## Secrets

No secret is needed. Every credential in a test is a throwaway value, either set in the workflow or made when the
test runs, and none is shaped like a real token (see [AGENTS.md](../AGENTS.md)). The one token is the `GITHUB_TOKEN`
that Actions gives each run, with read access only: it reads this repository's workflow runs and public repositories.

## How a suite is written

A suite uses `describeIt` from `test/support/it.ts`. It names the service and the variables that hold its address:

```ts
describeIt("jig-logs against Elasticsearch", { service: "elasticsearch", variables: ["JIG_IT_ELASTICSEARCH_URL"], hint: "a throwaway Elasticsearch 8" }, () => {
    // runs only when the variables are set; read them with must("JIG_IT_ELASTICSEARCH_URL")
});
```

- **The plugin's real code** runs: its tool, its configuration check, and `jig-core`'s request code (`kit/http.ts`,
  the OAuth code). Only Pi's screen and the parts of `jig-core` that need a session are replaced by the fakes the
  other tests of that plugin use.
- **Every suite makes its own data,** with names that include a random part, and removes it at the end, so two runs
  against one service do not meet.

## Pinned versions

Every image in the workflow has an exact version tag and its digest, and every action a commit SHA with its version in a
comment. To update one, change the tag and the digest together, then read the run.

## Running one on your machine

Start the service, set the variables that its section below lists, and run the file:

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
| `JIG_IT_ELASTICSEARCH_URL` | `https://127.0.0.1:9200`: Elasticsearch 8 with security on |
| `JIG_IT_ELASTICSEARCH_PASSWORD` | The password of its `elastic` user, which the tests use to make their own users |
| `NODE_EXTRA_CA_CERTS` | The node's certificate authority file, `config/certs/http_ca.crt` in the container |
| `JIG_IT_OPENSEARCH_URL` | `http://127.0.0.1:9201`: OpenSearch 2 with its security plugin off |
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

## Where to read a failure

The job prints each service's version once it is up. When a step fails, the last step prints the logs of every container,
each in its own group. A failed test names the backend, and its message shows the text the tool returned.
