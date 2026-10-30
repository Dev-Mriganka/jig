# Variables: where a value comes from

A saved request names variables as `{{name}}` in its address, headers, body and sign-in. This page says which value each gets.
Back to the [jig-api overview](../README.md).

## The order

1. **The values the agent gave** in `variables`, for a variable the request itself uses, and only if it is not a secret and does
   not fill the sign-in. Any other name is refused, with the ones the request uses.
2. **The environment's values,** then **the request's own** (a `.http` file's `@name = value`), then **the collection's**.
3. **Secrets,** which come from `api.secrets` and from nowhere else (below).
4. **Generated values:** `{{$uuid}}`, `{{$timestamp}}` (seconds) and `{{$isoTimestamp}}`, made at the moment the request is sent.

A variable with no value is invalid input and is named, every missing one at once:
`no value for sku, quantity in Staging: pass the ones the request uses in variables, or define them in the environment`.

A value of the environment may use other variables (`{{scheme}}://{{host}}/{{version}}`). The agent's values are not offered to
them, so the agent can only change what the request itself names, and a variable that refers to itself is refused.

## What the agent's values cannot do

A value stays a value. It is written into the text it lands in so that it cannot become structure:

| Where it lands | How it is written |
|---|---|
| The address | Percent-encoded as one piece: `a/b?c=d` is one path segment, and `.` or `..` is refused. It can never be part of the scheme or the host |
| A header | Printable ASCII only |
| A JSON body, inside a string | Escaped: quotes, backslashes and line ends |
| A JSON body, outside a string | A number, `true`, `false` or `null`, and nothing else |
| A URL-encoded form | Percent-encoded |
| XML or HTML | Escaped |
| A GraphQL query | Letters, digits and `_ . : @ + -` only. Use a GraphQL variable for anything else; the `variables` of the operation are JSON and escaped like any JSON |
| Plain text | As it is |

A value is text, a number or `true` or `false`, at most 2000 characters, with no control characters other than tab and line end.
What it holds is never read again: `{{token}}` in a value is the text `{{token}}`.

**The host.** A variable the agent gave that stands in the scheme or the host of an address is refused
(`baseUrl would set the host of the request: the host comes from the environment, not from the call`), however the address is put
together. The hosts a request may reach are the environment's own (see [Safety](safety.md#hosts)).

## Secrets

A variable is a secret if an environment file declares it so (a Postman `secret` type, any key of `http-client.private.env.json`)
or if `api.secrets` names it. Its value comes from the reference in `api.secrets`, resolved by `jig-core` at the moment the request
is sent, and from nowhere else. A value for it in a file is refused and never sent.

```json
"secrets": {
  "token": { "Staging": "pass:orders/staging-token", "Prod": "pass:orders/prod-token" },
  "apiKey": "env:ORDERS_API_KEY"
}
```

- A reference may be one for every environment, or one per environment. A secret is bound to its environment: the staging reference
  is never used in production, and an environment with no reference stops the request
  (`token is a secret, but api.secrets has no reference for it in Prod`).
- `api.secrets` is by variable name, across collections: `token` is the same secret wherever a collection names it.
- The plan holds no value. The preview and the fingerprint name the secret and its reference, never the value, and the value is
  read once the request is sent. A secret in a JSON string or a URL-encoded form is written escaped.
- A secret is never part of an address: it would be shown in the result and logged by servers. Send it in a header or the body.
- Every secret the tool sent is removed from the answer, in each of the forms a server may repeat it.

## Generated values

`{{$uuid}}` (and Postman's `{{$guid}}`), `{{$timestamp}}` and `{{$isoTimestamp}}` stay marks until the request is sent, so the
preview shows `{{$uuid}}` and the request that was approved is the request that goes out, with a new id. They cannot be in an
address. Every other `{{$name}}` refuses the request.
