# Writes: previews, and lost replies

What you see before a call that asks, what stops it if anything changed, and what
the tool does when no reply comes. Back to the [jig-http overview](../README.md).

## What you see before a call asks

A call that asks shows the target and its environment, how it signs in, the
method, the full address, the headers the model gave, and the body as indented
JSON with its size, cut to 200 lines.

```text
Target: billing-api (staging): Billing API, test copy
Sign-in: a bearer token, added by the tool
Method: POST
URL: https://billing-api.staging.example.com/v1/accounts
Headers:
  X-Request-Id: t1
Body (JSON, 29 bytes):
{
  "name": "Zed",
  "plan": "basic"
}
```

- **The sign-in is named and never shown.** It reads `none`, `a bearer token`,
  `an OAuth token (password grant)`, `sign-in service "<name>"` or `transport
  "<name>"`, and for all but the first, `added by the tool`. No reference, token
  or address of a sign-in is in the preview.
- **A long body is cut, and the whole body is sent.** After 200 lines a note says
  how many lines are not shown. The summary line is the method and the full
  address, cut at 300 characters; the address is whole in the body.
- **The preview contacts nothing and reads no secret.** It is made from the call
  and the configuration alone.

A call that does not ask, such as a `GET` by default, has no preview. A rule that
makes a read ask gives it a preview, and the guard below applies to it too.

## Changed since the preview

The plan is made again right before the call is sent. If what would be sent now
differs from the preview you approved, nothing is sent:

```text
http POST billing-api /v1/accounts: changed since the preview; run it again to see the new preview. Nothing was sent.
```

What is compared is the target, its environment, the way it signs in (the kind,
and the name of a service or a transport, never a secret), the method, the full
address, the headers and the body. Header names are compared in lower case and in
any order. The timeout is left out, because it changes how long the tool waits and
not what it sends. A change is caught whether the call or the configuration
changed while you read.

The message names the call without its query, its body or its headers.

## When no reply comes

A request is sent once. These are the three ways it can end without an answer:

| The tool says | When | Message |
|---|---|---|
| Nothing was sent | The request never left: no connection, a name that does not resolve, a certificate that is not accepted, an address that is not https, a sign-in that failed, a call cancelled before it was sent | `http POST billing-api /v1/accounts: could not connect (ECONNREFUSED). Nothing was sent.` |
| The outcome is unknown | A write got no answer: it timed out, the connection dropped or was reset, a transport failed, or the call was cancelled in flight | `http POST billing-api /v1/accounts: no answer (timed out after 30 s). The outcome is unknown: the server may have carried it out. It was not sent again. Check with a GET before trying again.` |
| It can be sent again | A `GET` got no answer | `http GET billing-api /v1/accounts/42: no answer (timed out after 30 s). A GET changes nothing, so it can be sent again.` |

Certificate checks are never turned off, and a certificate that is not accepted is
a failure before the request is written. A reply that comes after the timeout is
too late, and does not cause a second send.

**An error status is an answer.** A `500` to a write is a result, with a note that
the write may still have been carried out (see [Results](results.md)). It is not
sent again either.

The only request the tool ever repeats is one that the API turned down with a
`401` for a kept OAuth token. It is sent once more, with a new token (see
[Sign-in](auth.md#the-oauth-password-grant)).

## The clock

`timeoutSec` covers the requests, a token request included, and starts with the
first one. Time spent waiting for a secret store to be unlocked, or for a
sign-in service to answer, is not counted. One deadline covers the token request
and the call together: a deadline that started again for the call would let it
wait longer than `timeoutSec`.
