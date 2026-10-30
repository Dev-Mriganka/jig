# Sign-in: the five forms, and OAuth

How a target signs its requests in, and what each form holds. Back to the
[jig-http overview](../README.md).

The `auth` of a target is exactly one of these forms:

| `auth` | Signs in with | For |
|---|---|---|
| `{ "none": true }` | Nothing | An open API, or one that the network protects |
| `{ "bearer": "<secret reference>" }` | `Authorization: Bearer`, with the secret read for every call | An API token |
| `{ "oauthPassword": { ... } }` | The OAuth 2.0 password grant, described below | An API behind an OAuth server and a service account |
| `{ "signIn": "<service name>" }` | The headers of the company sign-in service of that name (for example a single sign-on gateway), asked for again on every request | A company's single sign-on |
| `{ "transport": "<name>" }` | The company transport of that name: the whole request goes through it, and the tool holds no credential and adds no header | A company that reaches an API only through a local sign-in proxy that holds the session |

## Secrets

A secret is a reference such as `pass:work/api-token` (see
[Secrets](../../../docs/secrets.md)). A secret written into the file is refused,
and the error does not repeat it. The name of a sign-in service or a transport is
text of up to 64 characters. With a sign-in service or a transport, the system it
is told is `http:<target>`.

## A bearer token

The secret is read for every call, and no call keeps it: `jig-core` owns it. A
secret that cannot be read, or that holds a character a header cannot hold, stops
the call before anything is sent, for a write too, and the error does not repeat
it. A `401` is an answer: the token is not replaced and the call is not sent
again.

## A sign-in service

The service is asked for the headers of every request, by name, with the system
`http:<target>` and the full address, because it is the one that knows when a
token has expired. Its headers are sent, and the tool adds no authentication of
its own. They replace the tool's own headers of the same name. A header that the
service sets cannot also be given by the caller, in any case: that is checked
when the call runs, before anything is sent. An unknown service, or one that
fails, stops the call before anything is sent, for a write too.

## A transport

The whole request goes through the transport, with the system, the method, the
full address, the headers and the body. The tool reads no secret, asks no
sign-in service and adds no header. The answer is read as an HTTP answer: the
status, the headers and a body as text, cut at 2 MiB like any other. A non-2xx
answer is a result and a redirect is not followed.

A transport that fails is reported in its own words, cut at 160 characters, and
for a write the outcome is then unknown (see [Writes](writes.md#when-no-reply-comes)).
A name that no company plugin registered means that nothing was sent.

## The OAuth password grant

| Field | Meaning |
|---|---|
| `tokenUrl` | The https address of the token endpoint, with no fragment. Plain `http` follows the same rule as `baseUrl` |
| `clientId` | The client's id, up to 200 characters |
| `clientSecret` | Optional, a secret reference. With it the client signs in with HTTP Basic (the id and the secret form-encoded, as RFC 6749 asks). Without it, only the id is sent |
| `username`, `password` | Secret references to the account |
| `scope` | Optional, up to 500 characters |

- **The grant.** The tool sends `grant_type=password` with the account, and the
  client id, as a form. It accepts a `200` answer with an `access_token` of 1 to
  8192 printable characters without a space, and sends it as a Bearer token. A
  token type other than `bearer` is refused. An answer of over 64 KiB is not
  read.
- **The token is kept in memory** until 60 seconds before its `expires_in`, which
  may be a number or text. A token that lives 60 seconds or less is never
  reused. Without an `expires_in`, or with one that is not a positive number, it
  is kept until a `401` says otherwise. It is kept per target, and dropped when
  the sign-in settings change: the address, the client id, any reference or the
  scope. A failed sign-in keeps nothing, so the next call tries again.
- **A `401` for a kept token** gets one new token and one repeat of the call,
  even for a write: the server turned the request down before it ran. A `401` for
  a token just issued is the answer, with a note: "The server rejected a newly
  issued token: the account may lack access to this path." There is no third
  try. Only a `401` replaces a token: a `403` or a `500` does not.
- **The token is never written to disk, logged, shown or put in an error.**
  `jig-core` cannot hide it, because it did not resolve it, so the tool removes
  it from every answer itself (see [Results](results.md#what-is-removed)).
- **A sign-in that fails** means nothing was sent to the API, and says why in one
  line: the endpoint's status and the standard error code, never its own words,
  the account or the secrets. Only the codes of RFC 6749, section 5.2, are
  repeated: `invalid_request`, `invalid_client`, `invalid_grant`,
  `unauthorized_client`, `unsupported_grant_type` and `invalid_scope`. A
  redirect from the token endpoint is not followed, and secrets that cannot be
  read stop the sign-in before the endpoint is asked.
- **One deadline** covers the token request and the call together (see
  [Writes](writes.md#the-clock)).

```json
{
  "http": {
    "targets": {
      "orders-api": {
        "baseUrl": "https://orders-api.staging.example.com",
        "environment": "staging",
        "auth": {
          "oauthPassword": {
            "tokenUrl": "https://auth.staging.example.com/oauth/token",
            "clientId": "orders-cli",
            "username": "pass:work/orders-user",
            "password": "pass:work/orders-password"
          }
        }
      }
    }
  }
}
```
