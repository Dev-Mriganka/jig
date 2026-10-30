# Configuration: every field of the `logs` section

The fields of `logs` in `~/.pi/agent/jig.json`, with their defaults and limits.
Back to the [jig-logs overview](../README.md).

`backend` and `environments` are both needed. `jig-core` reports an unknown or
invalid field, and the tool then says it is not configured instead of running half
set up.

Which environment fields apply depends on `backend.type`. A field that belongs to
the other type is an error that names it and the type it belongs to, such as
`logs.environments.staging.index is only used when logs.backend.type is
"elasticsearch"`.

## The backend

| Field | Default | Meaning |
|---|---|---|
| `backend.type` | `elasticsearch` | `elasticsearch` (also OpenSearch) or `loki` |
| `backend.url` | required | Where the backend is, without the index or `/loki/api/v1` |
| `backend.auth` | required with a direct `url` | A user name and password, an `apiKey`, a `token`, or a `signIn` service |
| `backend.transport` | none | In place of `auth`: the name of a company transport |
| `backend.tenant` | none | Loki only: the tenant, sent as the header `X-Scope-OrgID` |

- **`backend.type`:** a section without a type is Elasticsearch, so a file written
  before there was another keeps working.
- **`backend.url`:** a direct `url` must be `https://`; a transport's may be
  `http://` or `https://`. It may hold a path, and must not hold a user name, a
  password, a query string or a fragment.
- **`backend.auth`:** one of four kinds (see [Connecting](connecting.md)). A
  password, key or token is always a secret reference, such as `pass:logs/api-key`
  or `env:LOGS_KEY` (see [Secrets](../../../docs/secrets.md)), never the secret.
- **`backend.transport`:** a transport that a company plugin registered with
  `jig-core`. It carries each request and signs it in.
- **`backend.tenant`:** visible characters without spaces, up to 300.
## An environment

`environments` maps the name the tool uses to that environment's settings, at least
one and at most 50. A name has up to 64 letters, digits and `.`, `_` and `-`.

| Field | Default | Meaning |
|---|---|---|
| `index` | required for Elasticsearch | The index name or pattern, such as `app-logs-*` |
| `timeField` | `@timestamp` | Elasticsearch: the date field that windows and sorting use |
| `messageField` | `message` | Elasticsearch: the text field that `phrase` and `query` search |
| `filter` | none | Fields (Elasticsearch) or labels (Loki) that must equal a value, or one of a list. Up to 8 entries |
| `selector` | required for Loki | A LogQL stream selector, such as `{app="orders-api", env="staging"}` |
| `jigEnvironment` | the name itself | The `jig-core` environment this search is classified in |

- **`index`:** several can be listed with commas.
- **`messageField`:** hits show it too. A dotted name such as `log.message` works
  whether the documents nest it or not.
- **`filter`:** for an index that holds several environments, such as
  `{ "env.keyword": "production" }`. An entry is one value (text, a number, `true` or
  `false`) or a list of 1 to 50 of them, such as `"namespace.keyword": ["orders",
  "billing"]`, which keeps a hit whose field is any of the values.
  - **Elasticsearch:** a value is an exact `term` and a list is a `terms`, so name a
    keyword field.
  - **Loki:** each entry is a matcher added to the selector: `region="eu"` for one
    value, `namespace=~"orders|billing"` for a list. The name is a label of the
    stream (letters, digits and `_`), and each value is matched literally, with its case.
- **`selector`:** up to 1000 characters, with at least one `=` or `=~` matcher that
  has a value. It names the streams of the environment, and comes from here and
  never from the model.
- **`jigEnvironment`** decides masking and rules.

## Examples

Elasticsearch, with one index that holds two environments:

```json
{
  "logs": {
    "backend": { "url": "https://logs.example.com:9200", "auth": { "apiKey": "pass:logs/api-key" } },
    "environments": {
      "staging": { "index": "app-logs-*", "filter": { "env.keyword": "staging" } },
      "production": { "index": "app-logs-*", "filter": { "env.keyword": "production" } }
    }
  }
}
```

Loki, as Grafana Cloud takes it: the user of the stack, and an API token as the password. The address is the one in the
stack's Loki details:

```json
{
  "logs": {
    "backend": {
      "type": "loki",
      "url": "https://logs.example.com",
      "auth": { "username": "12345", "password": "pass:logs/loki-token" }
    },
    "environments": {
      "staging": { "selector": "{app=\"orders-api\", env=\"staging\"}" },
      "production": { "selector": "{app=\"orders-api\", env=\"production\"}" }
    }
  }
}
```

One environment that keeps the hits of either of two namespaces (Loki's version is in
[Loki](loki.md#configure)):

```json
{
  "logs": {
    "backend": { "url": "https://logs.example.com:9200", "auth": { "apiKey": "pass:logs/api-key" } },
    "environments": {
      "staging": { "index": "app-logs-*", "filter": { "namespace.keyword": ["orders-api", "billing-api"] } }
    }
  }
}
```

A company transport in place of `auth`:

```json
{ "logs": { "backend": { "transport": "corp", "url": "https://logs.example.com" }, "environments": { "staging": { "index": "app-logs-*" } } } }
```
