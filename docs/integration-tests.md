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

Start the service, set its variables, and run the file:

```bash
JIG_IT_REQUIRE= npm run test:it
```

The sections below, one for each plugin, list the variables and how the workflow starts the service.
