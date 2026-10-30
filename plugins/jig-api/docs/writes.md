# Writes: previews, and lost replies

What you see before a call that asks, what stops it if anything changed, and what the tool does when no reply comes. Back to the
[jig-api overview](../README.md).

## What you see before a call asks

A call that asks shows the request and its environment, how it signs in, the method, the full address, the headers and the body, with
every variable filled in except the secrets and the values made at the moment of sending.

```text
Request: Create order (orders) in Staging (staging)
Sign-in: a bearer token, added by the tool
Method: POST
URL: https://api.staging.example.com/v1/orders
Headers:
  Content-Type: application/json
  Idempotency-Key: {{$uuid}}
Body (JSON, 44 bytes):
{
  "customerId": "cust-1",
  "sku": "W-1"
}
Secrets, read when it is sent and never shown: token
Made when it is sent: $uuid
```

- **The sign-in is named and never shown.** It reads `none`, `a bearer token`, `a user name and password (HTTP Basic)`,
  `an API key in the <name> header`, `an OAuth token (client credentials)`, `sign-in service "<name>"` or `transport "<name>"`.
  - For all but the first, it adds `added by the tool`.
  - No reference, token or address of a sign-in is in the preview.
- **A secret is shown by the name of its variable.** `{{token}}` where it is used, and a line that lists them. The preview reads no
  secret; the value is read when the request is sent.
- **A file is shown by its name, size and digest,** never its content.
- **A long body is cut, and the whole body is sent.** After 200 lines a note says how many lines are not shown. The summary line is the
  method and the full address, cut at 300 characters; the address is whole in the body.
- **A folder is one preview:** each request in order, approved once.
- **The preview contacts nothing and reads no secret.** It is made from the call, the collections' files and the configuration alone.

A call that does not ask, such as a read by default, has no preview. A rule that makes a read ask gives it a preview, and the guard
below applies to it too.

## Changed since the preview

The plan is made again right before the call is sent. If what would be sent now differs from the preview you approved, nothing is sent:

```text
api run "Create order": changed since the preview; run it again to see the new preview. Nothing was sent.
```

What is compared:
- the collection, the request, its environment and `jig-core`'s name for it;
- how it signs in (the kind, and the name of a service or a transport);
- the secrets it uses with their references (never their values);
- the method, the full address, the headers, the body and the digest of every file in it.

A generated value is a mark, so it is the same at the preview and at the send. Header names are compared in lower case and in any
order. The timeout is left out, because it changes how long the tool waits and not what it sends.

A change is caught whether the call, the configuration or a file changed while you read.

The message names the call without its query, its body or its headers.

## When no reply comes

A request is sent once. These are the three ways it can end without an answer:

- **Nothing was sent:** the request never left. That is no connection, a name that does not resolve, a certificate that is not
  accepted, an address that is not allowed, a sign-in that failed, or a call cancelled before it was sent.
  - Example: `api run "Create order": could not connect (ECONNREFUSED). Nothing was sent.`
- **The outcome is unknown:** a write got no answer. It timed out, the connection dropped or was reset, a transport failed, or the
  call was cancelled in flight.
  - Example: `api run "Create order": no answer (timed out after 30 s). The outcome is unknown: the server may have carried it
    out. It was not sent again. Check with a GET before trying again.`
- **It can be sent again:** a read got no answer.
  - Example: `api run "Get order": no answer (timed out after 30 s). A GET changes nothing, so it can be sent again.`

Certificate checks are never turned off, and a certificate that is not accepted is a failure before the request is written. A reply
that comes after the timeout is too late, and does not cause a second send.

**An error status is an answer.** A `500` to a write is a result, with a note that the write may still have been carried out (see
[Results](results.md)). It is not sent again either. In a folder, a request that gets no answer stops the folder.

The only request the tool ever repeats is one that the API turned down with a `401` for a kept OAuth token. It is sent once more, with a
new token (see [Sign-in](auth.md#oauth-without-a-browser)).

## The clock

`timeoutSec` covers the requests, a token request included, and starts with the first one. Time spent waiting for a secret store to be
unlocked, or for a sign-in service to answer, is not counted. One deadline covers the token request and the call together: a deadline
that started again for the call would let it wait longer than `timeoutSec`.
