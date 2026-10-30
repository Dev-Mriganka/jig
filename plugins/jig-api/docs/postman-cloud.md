# Postman cloud: a collection fetched to a local copy

How a collection kept in a Postman workspace becomes saved requests. Back to the [jig-api overview](../README.md).

```json
{ "postman": { "cloud": "12345678-12ece9e1-2abf-4edc-8e34-de66e74114d2",
               "apiKey": "pass:postman/api-key",
               "environments": { "Staging": "12345678-5daabc50-8451-43f6-922d-96b403b4f28e" } } }
```

| Field | Meaning |
|---|---|
| `cloud` | The collection's id (`<owner>-<uuid>`): letters, digits and `-` only |
| `apiKey` | A secret **reference** for the Postman API key, such as `pass:postman/api-key`. A key pasted here is refused without being repeated |
| `environments` | Your collections' environment names to the ids of the environments in Postman |
| `region` | `"us"` (default) or `"eu"`, the region of your Postman data. The key is sent to `api.postman.com` or `api.eu.postman.com` only |
| `transport`, `signIn` | Optional, one of them: a company transport or sign-in service that carries the fetch ([Sign-in](auth.md)) |

## Reading, and the local copy

Reading never touches the network. It reads the copy in `<state>/api/postman-cloud/<id>.json`, where `<state>` is `$JIG_STATE_DIR`,
else `jig` under `$XDG_STATE_HOME` or `~/.local/state`. The copy is private to you (mode 0600, folders 0700) and is written whole or
not at all. It holds the answers of the API: the collection (format v2.1) and each environment, **except the value of a secret
variable**, which is never kept; the copy is read by the Postman reader ([Postman](postman.md)). Environments are named as you
named them.

A collection with no copy is listed with one problem, `has not been fetched yet: run /api refresh <name>`, and has no requests. A
request that uploads a file is refused: a cloud collection has no folder for files.

## `/api refresh [collection]`

You type it; the agent cannot. It fetches the collection and then each environment, with the key in `X-API-Key`, and says what
changed:

```text
orders: fetched the collection and 1 environment
  25 requests; added: Orders/Refund order; removed: Orders/Old; changed: Orders/Get order
  Staging: added region; changed customerId
  Staging: token is a secret with a value in Postman; the value is not kept, so give it in api.secrets
```

- **The fetch is a request of the engine,** so a `transport` or `signIn` carries it, and the key is read by `jig-core` at the moment
  the request is sent. The key is in no message, no error, no result and not in the copy; whatever the service or a transport says,
  the words are the tool's, and anything of a key's shape is removed.
- **A failure leaves the copy as it was,** and says why in a few words: the key was not accepted (401 or 403), the service does not
  know the id (400 or 404), the rate limit (429), the service failed (5xx), no answer in time, or the secret could not be read. If
  one environment fails, the others are saved and its earlier copy is kept.
- **Variables are reported by name,** never by value.
- A collection of up to 32 MiB is fetched; the usual limit on an answer does not apply to it.
- Without a name it refreshes every Postman cloud collection. A collection read from files has nothing to fetch.

## A collection access key is not used

Postman can give a read-only key for one collection, which goes in the address (`?access_key=...`). An address ends up in logs and in
results, so a key is never part of one here. Use an API key, in a header.
