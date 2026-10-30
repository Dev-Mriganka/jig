# jig-api: your team's saved API requests, run safely

**Status: design.** The sending engine is built and tested (it was `jig-http`):
sign-in, OAuth, transports, previews and lost-reply checks. The collection
sources are being built.

`jig-api` lets the agent run the API requests your team already keeps, by
name, filling only their variables. Wherever the collection lives, sign-in is
added by the tool, and the result is governed like every other call. For
example, after deploying a change to `staging`, the agent runs your saved
**Get order** request with `orderId=123`. It reads, so it runs at once. Your
saved **Create order** asks you first, showing the exact request; in
`production` the floor denies it.

## What it is for

| Use | How |
|---|---|
| Check a deployed change | Run a saved request against `staging` |
| Reproduce a ticket's bug | Run the saved write with the ticket's data in `staging`; you approve it |
| Read production state safely | Run a saved read in `production`; the result is masked, and writes are denied |
| Smoke-test after a deploy | Run a folder of saved requests and get one line per request |
| Try an endpoint nobody saved yet | An ad-hoc call or an OpenAPI operation, in a test environment you allowed |

## Where collections come from

| Source | Where teams keep it | What is read |
|---|---|---|
| **Bruno** | Files in git: OpenCollection YAML, or `.bru` | Requests, folders, environments, `vars:secret` and `secret: true` markers |
| **Postman** | Collection v2.1 JSON and environment exports, or the cloud workspace by id with an API key | Requests, folders, variables, auth, environment values and `secret` types |
| **`.http` files** | Files in git (JetBrains, VS Code, Visual Studio) | `###` requests with `# @name`, `http-client.env.json` and the private env file |
| **OpenAPI** | The service's spec | Operations by `operationId`, for test environments you allow |

Hurl, Insomnia and Postman's newer YAML layout come next. A source is a small
adapter, so others can be added (see Later).

## Tool: `api`

| Action | Kind | What it does |
|---|---|---|
| `list` | read | Saved requests by collection and folder, with their method, path and the variables they need. Filter by text |
| `show` | read | One request in full: URL template, headers (names only for secrets), body template, variables, docs |
| `run` | depends on the request | Runs one saved request in an environment, with variables. A `GET` reads; other methods write, unless you mark the request a read |
| `run-folder` | the strictest of its requests | Runs a folder in order, stopping at the first failure. One line per request |
| `call` | depends on the method | An ad-hoc request in an environment where you allowed it. Off by default, and never production |

A request's name is its action, so a rule can name one request:
`{ "tool": "api", "action": "Create order", "environment": "staging", "decision": "allow" }`.

## Rules

- **Saved requests first.** The agent fills variables; it cannot change a
  request's host, method or headers. Ad-hoc calls are opt-in per environment.
- **Requests are sent by the tool, not by your API client's CLI.** Collection
  scripts never run: a request that needs a pre-request script is refused,
  with its name. Most requests need none.
- **Hosts are pinned per environment.** A request whose host is not one of its
  environment's hosts is refused. So are link-local and cloud-metadata
  addresses. Redirects are never followed, and no cookies are kept.
- **Secrets never come from the model.** A variable your format marks secret
  needs a secret reference in configuration, such as `pass:orders/token`, and
  is bound to its environment's hosts. Plain secret values in an export are
  refused, with a warning that names the file.
- **Files stay in the collection.** A file a request uploads must sit inside
  its collection folder, after following links.
- **Only headless sign-in.** OAuth works with client credentials or a password
  grant. Anything that needs a browser is refused.
- **Plain HTTP only.** GraphQL is a `POST` and works. gRPC, WebSocket and MQTT
  requests are refused as unsupported, not skipped silently.
- **The rest is `jig-core`'s:** reads run, a write to a test environment asks
  you with a preview, production writes are denied, production results are
  masked, and an unknown outcome is checked once, never resent.

## Configure

In `~/.pi/agent/jig.json`, under `api`:

```json
{
  "api": {
    "collections": {
      "orders": { "bruno": "~/work/orders-api/collection" },
      "billing": { "postman": "~/work/billing.postman_collection.json",
                   "environments": { "staging": "~/work/billing-staging.postman_environment.json" } }
    },
    "environments": { "Staging": "staging", "Prod": "production" },
    "secrets": { "token": "pass:orders/token" },
    "reads": ["Search orders"],
    "adHoc": ["staging"]
  }
}
```

| Field | Meaning |
|---|---|
| `collections` | Named sources: `bruno`, `postman` (a file, or `{ "cloud": "<collection id>", "apiKey": "<secret ref>" }`), `http` (a folder of `.http` files) or `openapi` |
| `environments` | Your collection's environment names, mapped to `jig-core`'s. A name not mapped counts as production |
| `secrets` | Secret variables, by name, mapped to secret references |
| `reads` | Requests that read although their method is not `GET`, such as a search sent as `POST` |
| `adHoc` | Test environments where `call` is allowed |

## Company part (in the company plugin)

- where its collections live, and their environment mapping;
- a transport, for APIs only reachable through a bastion host, a VPN or a
  sign-in proxy.

## Later

- **Hurl, Insomnia and Postman's YAML layout** as sources.
- **Collections with scripts,** run by their own CLI only in a test
  environment you opt into, with the output masked again.
- **Asserts,** as declared in Bruno and Hurl files, reported by `run-folder`.

## Layout (planned)

```text
jig-api/
  src/      engine/ (sending, sign-in, OAuth, previews), sources/ (one adapter per format), model, tool, config
  skills/   api/SKILL.md: list, show, then run; read before you write
  test/     per-source fixtures, the engine's tests, safety tests
```
