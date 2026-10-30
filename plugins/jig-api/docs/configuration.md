# Configuration: every field of the `api` section

The fields of `api` in `~/.pi/agent/jig.json`, with an example of each source. The
short table is in the [jig-api overview](../README.md#configure). Back to the
overview.

An unknown field is an error, and the tool then does nothing until the file is
fixed (`/jig` lists the problems).

```json
{
  "api": {
    "collections": {
      "orders": { "http": "~/work/orders-api/http" },
      "billing": { "postman": "~/work/billing.postman_collection.json",
                   "environments": { "Staging": "~/work/billing-staging.postman_environment.json" } },
      "shop": { "bruno": "~/work/shop-api/bruno" },
      "catalog": { "openapi": "~/work/catalog/openapi.yaml", "environments": ["Staging"],
                   "servers": { "Staging": "https://api.staging.example.com/v1" } },
      "team": { "postman": { "cloud": "<collection id>", "apiKey": "pass:postman/api-key",
                             "environments": { "Staging": "<environment id>" } } }
    },
    "environments": { "Staging": "staging", "Prod": "production" },
    "secrets": { "token": "pass:orders/token" },
    "reads": ["Search orders"],
    "adHoc": ["staging"]
  }
}
```

## The fields

- **`collections`:** named sources. Paths are absolute or start with `~/`.
  - **`postman`** is a file, with its `environments` as a name to file map; or a
    cloud `{ cloud, apiKey, environments }`.
  - **`http`** and **`bruno`** are a folder.
  - **`openapi`** is a file, with `environments`, `servers` and
    `allowProductionReads`.
- **`environments`:** your collections' environment names, mapped to `jig-core`'s.
  A name that is not mapped counts as production. A value may be
  `{ "environment": "staging", "signIn": "<service>" }` or
  `{ "environment": "staging", "transport": "<name>" }`.
- **`secrets`:** secret variables, by name, mapped to secret references, or per
  environment: `{ "token": { "Staging": "pass:a", "Prod": "pass:b" } }`.
- **`reads`:** requests that read although their method is not `GET`, such as a
  search sent as `POST`.
- **`adHoc`:** `jig-core` test environments where `call` is allowed. Each must be
  one that `environments` maps to.
- **`timeoutSec`:** seconds to wait for an answer when a call gives none: 1 to
  120, default 30.
- **`allowPlainLocal`:** allows `http://127.0.0.1` and `http://localhost`, for a
  service beside Pi and for tests. The default is `false`.
