# Connecting: how a request travels

The adapter of the backend describes each request (see [Backends](backends.md)): a
method, a path, headers and perhaps a JSON body. There is one request function,
and everything above it (the query, the buckets, the reading of replies) does not
know which way a request travels. Back to the [jig-logs overview](../README.md).

## Directly

Over HTTPS, signed in with one of four kinds of `auth`. Redirects are not
followed, so a credential never goes to an address the configuration did not
name.

| `auth` | What is sent |
|---|---|
| `{ "username": "reader", "password": "pass:logs/reader" }` | `Authorization: Basic ...`. The user name cannot hold a colon. Grafana Cloud's Loki takes this form, with the user of the stack and an API token |
| `{ "apiKey": "pass:logs/api-key" }` | `Authorization: ApiKey <the secret>`. The secret is the key as Elasticsearch gives it (`encoded`) |
| `{ "token": "pass:logs/token" }` | `Authorization: Bearer <the secret>` |
| `{ "signIn": "<service name>" }` | The headers of the company sign-in service of that name (for example a single sign-on gateway), asked for on every request |

The request carries `accept: application/json`, and `content-type:
application/json` when it has a body. The adapter may add headers of its own, such
as Loki's tenant, `X-Scope-OrgID`, which is sent through a transport too; the
sign-in's headers come last and win. A sign-in service is asked for the system
`logs` and the full address of the request. The tool uses Node's certificate store, so
`NODE_EXTRA_CA_CERTS` applies to a private certificate authority as it does to
the rest of Pi.

## Through a transport

A company plugin registers a transport with `jig-core`: code that carries the
request, for example through a local sign-in proxy that holds the session. Every
request goes to `jig().transports.request(name, { system: "logs", method, url,
headers, body })`, with the same headers as a direct request. No authorization
header is added, because the transport signs in. What it answers is read like a
direct reply.

## Time and cancellation

Each request has 30 seconds, whichever way it travels.
- **Directly,** the 30 seconds start once the credential is in hand. They do not
  run while a secret is being unlocked or a sign-in service is working.
- **Through a transport,** they cover the whole exchange, because the transport
  signs in inside it.
- **A transport that ignores its signal** neither holds the call past the 30
  seconds nor makes stopping the call wait for it.

Stopping the call stops the request, and the wait for a secret, at once.

## Secrets and sign-in

A secret reference is resolved once per call, by `jig-core`, and only through a
backend that its `secrets.backends` allows. A search of many buckets asks the
secret store once, and the next call asks again: nothing is kept between calls. A
lookup that failed is made again by the next request. A sign-in service is asked
for every request, because it is the one that knows when a token has run out. A
mistake in a reference never repeats the value.

## Replies

A reply over 16 MiB is refused, whichever way it came. A direct reply is read as
it arrives, so the rest of it is dropped before it is all in memory. The window
becomes a `response_too_large` gap (see [Failures](failures.md#gaps-and-their-reasons)).
