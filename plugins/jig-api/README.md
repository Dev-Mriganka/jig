# jig-api: your team's saved API requests, run safely

**Status: built.** The sending engine (sign-in, OAuth, transports, previews and
lost-reply checks) and five sources, each tried against fake APIs on this machine
and not yet against a real service (see [Not verified yet](docs/not-verified.md)):
- **Postman** collection files (v2.1, with environment files);
- folders of **`.http` files**;
- **Bruno** collections (OpenCollection YAML and `.bru`);
- **OpenAPI** specs;
- a **Postman cloud** workspace.

`jig-api` lets the agent run the API requests your team already keeps, by name,
filling only their variables. Wherever the collection lives, sign-in is added by
the tool, and the result is governed like every other call.

For example, after deploying a change to `staging`, the agent runs your saved
**Get order** request with `orderId=123`. It reads, so it runs at once. Your
saved **Create order** asks you first, showing the exact request; in
`production` the floor denies it.

## What it is for

- **Check a deployed change:** run a saved request against `staging`.
- **Reproduce a ticket's bug:** run the saved write with the ticket's data in
  `staging`; you approve it.
- **Read production state safely:** run a saved read in `production`; the result
  is masked, and writes are denied.
- **Smoke-test after a deploy:** run a folder of saved requests and get one line
  per request.
- **Try an endpoint nobody saved yet:** an ad-hoc call, in a test environment you
  allowed.

## Where collections come from

| Source | Where teams keep it | Status |
|---|---|---|
| **Postman** | Collection v2.1 JSON and environment exports ([details](docs/postman.md)) | built |
| **`.http` files** | Files in git: JetBrains, VS Code, Visual Studio ([details](docs/http-files.md)) | built |
| **Bruno** | Files in git: OpenCollection YAML, or `.bru` ([details](docs/bruno.md)) | built |
| **OpenAPI** | The service's spec, for the environments you list ([details](docs/openapi.md)) | built |
| **Postman cloud** | A workspace, by id with an API key, fetched by `/api refresh` ([details](docs/postman-cloud.md)) | built |

A source is a small adapter, so others can be added ([how](docs/sources.md)).

`/api refresh [collection]` is yours to type: it fetches Postman cloud collections
to their local copy and says what changed.

## Tool: `api`

| Action | Kind | What it does |
|---|---|---|
| `list` | read | Saved requests by collection and folder, with method, address and variables |
| `show` | read | One request in full: address, headers, body, where each variable gets its value |
| `run` | depends on the request | Runs one saved request in an environment, with variables |
| `run-folder` | the strictest of its requests | Runs a folder in order, stopping at the first failure |
| `call` | depends on the method | An ad-hoc request where you allowed it. Off by default, never production |

- **`list`** can filter by text, and says whether each request reads.
- **`run`:** `GET`, `HEAD` and `OPTIONS` read; other methods write, unless the
  request is in `reads`.
- **`run-folder`** gives one line per request.

A request's name is its action, so a rule can name one request:
`{ "tool": "api", "action": "Create order", "environment": "staging", "decision": "allow" }`.
Parameters and their checks: [Parameters](docs/parameters.md).

## Rules

- **Saved requests first.** The agent fills variables; it cannot change a request's host, method
  or headers ([Variables](docs/variables.md)). Ad-hoc calls are opt-in per environment.
- **Requests are sent by the tool, not by your API client.** Scripts never run: a request that a
  pre-request script applies to is refused, with its name. Test scripts are ignored, with a note.
- **Hosts are pinned per environment.** A request whose host is not one of its environment's
  hosts is refused. So are link-local and cloud-metadata addresses. Redirects are never
  followed, and no cookies are kept ([Safety](docs/safety.md)).
- **Secrets never come from the model.** A secret variable needs a reference in `api.secrets`,
  such as `pass:orders/token`. A plain value for it in a file is refused, with a warning that
  names the file and the variable. Bruno's `{{process.env.NAME}}` and an OpenAPI security scheme
  are secrets too; no `.env` file is read.
- **OpenAPI is opt-in.** A spec runs only in the environments you list, against the servers you
  map to them, and in production only for reads with `allowProductionReads`.
- **Limits.** An upload must sit inside its collection folder. Sign-in is
  headless only: bearer, Basic, an API key in a header, OAuth with client
  credentials or a password grant ([Sign-in](docs/auth.md)). Requests are plain
  HTTP; GraphQL is a `POST` and works, while gRPC, WebSocket and MQTT requests are
  listed and refused, not skipped silently.
- **The rest is `jig-core`'s:** reads run, a write to a test environment asks you with a
  preview, production writes are denied, production results are masked, and an unknown outcome
  is checked once, never resent ([Writes](docs/writes.md)).

## Configure

In `~/.pi/agent/jig.json`, under `api`. An unknown field is an error, and the tool
then does nothing until the file is fixed (`/jig` lists the problems).

```json
{ "api": { "collections": { "orders": { "http": "~/work/orders-api/http" } }, "environments": { "Staging": "staging" } } }
```

| Field | Meaning |
|---|---|
| `collections` | Named sources: `postman`, `http`, `bruno` or `openapi`. Paths start with `~/` or `/` |
| `environments` | Your collections' environment names, mapped to `jig-core`'s |
| `secrets` | Secret variables, by name, mapped to secret references |
| `reads` | Requests that read although their method is not `GET` |
| `adHoc` | `jig-core` test environments where `call` is allowed |
| `timeoutSec` | Seconds to wait for an answer: 1 to 120, default 30 |
| `allowPlainLocal` | Allows `http://127.0.0.1` and `http://localhost`. Default `false` |

An environment name that is not mapped counts as production. Every field, with an
example of each source, is in [Configuration](docs/configuration.md).

## Company part (in the company plugin)

- where its collections live, and their environment mapping;
- a transport or a sign-in service, for APIs only reachable through a bastion host, a VPN or a
  sign-in proxy, named in `environments`.

## Later

- **Hurl, Insomnia and Postman's YAML layout** as sources.
- **Collections with scripts,** run by their own CLI only in a test environment you
  opt into, with the output masked again.
- **Asserts,** as declared in Bruno and Hurl files. Bruno's are read and shown
  today; `run-folder` would report them.
- **The Postman CLI and `bru`,** so those tools sign in themselves. Not built: Jig
  never signs in (see [Decisions](../../docs/decisions.md)).

## Layout

```text
jig-api/
  src/      the tool and its checks (index, tool, params, config, ad-hoc, refresh), collections (model, template,
            catalog, sources/ with one adapter per format), a request worked out (resolve, planning, optional, show),
            engine/ (sending through jig-core's request, previews, results)
  skills/   api/SKILL.md: list, show, then run; read before you write
  test/     fixtures of an example orders API in every format, the engine's tests, the safety tests
  docs/     the detail pages below
```

## More detail

- [Postman](docs/postman.md), [`.http` files](docs/http-files.md), [Bruno](docs/bruno.md), [OpenAPI](docs/openapi.md) and
  [Postman cloud](docs/postman-cloud.md): what is read, and what is refused
- [Variables](docs/variables.md): the order values come in, and how the agent's are written
- [Safety](docs/safety.md): pinned hosts, blocked addresses, files, scripts
- [Configuration](docs/configuration.md): every field of the `api` section, with an example of each source
- [Parameters](docs/parameters.md), [Sign-in](docs/auth.md), [Results](docs/results.md), [Writes](docs/writes.md)
- [Adding a source](docs/sources.md): the interface an adapter implements
- [Not verified yet](docs/not-verified.md): what needs a real service
