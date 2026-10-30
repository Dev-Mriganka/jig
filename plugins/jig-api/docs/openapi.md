# OpenAPI: what is read, and why it is opt-in

How a service's OpenAPI spec (3.0 or 3.1, JSON or YAML) becomes runnable requests. Back to the [jig-api overview](../README.md).

```json
{ "openapi": "~/work/orders-api/openapi.yaml",
  "environments": ["Staging"],
  "servers": { "Staging": "https://api.staging.example.com/v1" } }
```

A spec describes what an API can do, not what a team saved to run, and its servers rarely match a team's environment names. So an
OpenAPI collection is held tighter than the others.

| Field | Meaning |
|---|---|
| `openapi` | The spec file, absolute or `~/`. JSON or YAML; at most 8 MiB. A Swagger 2.0 file is a problem |
| `environments` | **Required.** The environments the spec may run in, by your collections' names (the keys of `api.environments`). It runs nowhere else |
| `servers` | The server of each of those environments: one address with a base path, no `{variables}`. The spec's own `servers` are not used as hosts |
| `allowProductionReads` | Default `false`. A read in an environment that counts as production runs only when this is `true` |

## Where it runs

- **Only where listed.** An environment not in `environments` does not exist for this collection.
- **Hosts are the mapped servers.** Every address is `{{serverUrl}}/path`, and `serverUrl` is the server mapped to the environment.
  The agent cannot give it. An environment with no server in `servers` is listed and has no host: `list` says "unavailable", and
  every operation is refused there, with what to add.
- **Production.** What counts as production is asked of `jig-core`. A read there is refused unless `allowProductionReads` is `true`; a
  write there is denied by the floor whatever is configured ([Permissions](../../../docs/permissions.md)). An environment that
  `api.environments` does not map counts as production.

## Operations

Each operation with an `operationId` is a request named by it, in the folder of its first tag. An operation without one is listed as
`GET /legacy/ping` and refused, with a note: it has no name to run it by. An `operationId` used twice refuses the later operation.
Operations with servers of their own, and the method `TRACE`, are refused. `$ref`s inside the document are followed; one that points
to another file is a problem and is not followed.

## Parameters and the body

| In the spec | Becomes |
|---|---|
| A path parameter | A required variable, written into the address as one path segment |
| A query parameter | A variable, in the query string. Optional unless `required` |
| A header parameter | A variable, as a header. Optional unless `required` |
| A JSON `requestBody` | One variable for each scalar property, such as `customerId` or `address.city`; strings are written in quotes, numbers and flags bare. `allOf` is merged |

- **Required is enforced; optional is left out.** A required variable with no value is refused, naming all that are missing. An
  optional one that nobody gives is left out of the request: its query pair, its header, its JSON property, and an object with
  nothing left in it. `list` shows `needs` and `optional`, and `show` says what each variable is.
- **A property inside an optional object is optional too,** even if the spec requires it of the object when it is present.
- **Two parameters of one name** (`id` in the path and in the body) are told apart by their place: `path.id` and `body.id`.
- **What cannot be a variable:** a list, an object nested deeper than two levels, a choice between shapes, a file, a cookie. When
  optional it is left out with a note; when required the operation is refused.
- **Credentials are never the agent's.** `Authorization`, `Accept` and `Content-Type` parameters are ignored, as the specification
  says. A parameter that carries a credential (`Cookie`, or a name like `X-Api-Key` or `...Token`) is ignored when the sign-in sends
  it, and otherwise refuses the operation if it is required: declare it as a security scheme.
- **Only JSON bodies** are filled. A required `multipart/form-data`, form or text body refuses the operation.
- The tool does not check a value against the schema (type, range, enum): the server does.

## Sign-in: slots filled from `api.secrets`

An operation's `security`, else the spec's, names the scheme. The first alternative that is one scheme this plugin can send is used;
`{}` (no sign-in) is used when nothing else can be. Each scheme becomes **secret slots**, named for the scheme, which come from
`api.secrets` and from nowhere else ([Variables](variables.md#secrets)).

| Scheme | Slots |
|---|---|
| `http` `bearer` | `<scheme>` |
| `http` `basic` | `<scheme>.username`, `<scheme>.password` |
| `apiKey` in a header | `<scheme>` |
| `oauth2` `clientCredentials` | `<scheme>.clientId`, `<scheme>.clientSecret`; the scopes of the requirement are asked for |
| `oauth2` `password` | those two, and `<scheme>.username`, `<scheme>.password` |

```json
"secrets": { "bearerAuth": { "Staging": "pass:orders/staging-token" }, "basicAuth.password": "pass:orders/svc" }
```

**Refused, by name:** an API key in the query string or a cookie; `oauth2` with only `implicit` or `authorizationCode`; OpenID Connect;
mutual TLS; HTTP schemes other than bearer and basic; an unknown scheme; and a requirement that needs several schemes at once. A
token address must be on the environment's host: a relative one is on the server, one with a host is accepted only when that host
is one of the spec's own servers (it then follows the environment's server), and any other is refused. A company sign-in service or
transport named in `api.environments` replaces all of this, as for every source.
