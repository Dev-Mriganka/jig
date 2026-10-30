# Results: what the tool returns

What the model reads after a call, and what is removed from it. Back to the [jig-api overview](../README.md).

`list` and `show` return text (see [Parameters](parameters.md)). `run` and `call` return a status line, the request and its
environment, a few headers and the body. A non-2xx answer is a normal result, not an error: the status and the body are what the model
reasons from.

```text
POST https://api.staging.example.com/v1/orders -> HTTP 201 Created
Request: Create order (orders) in Staging (staging)
content-type: application/json
location: /v1/orders/42

{
  "id": 42
}
```

| What | How it is shown |
|---|---|
| The status line | The method, the full address and the status with its standard words, never the server's own, so a server cannot put text there. A status without standard words has none |
| The request | Its name, the collection, and the environment as the collection names it and as `jig-core` knows it; `call` for an ad-hoc request |
| Headers | `content-type`, `location`, and trace or request ids (a name that holds `trace`, `request-id`, `requestid`, `correlation-id` or `correlationid`); at most 6, with names in lower case and each value on one line, cut at 200 characters. Cookies are never among them |
| JSON | Re-indented by two spaces with its numbers, strings and escapes untouched, so a long id reads as the service sent it. It is recognised whatever the content type says. Not cut here: `jig-core` cuts a very long result and keeps the whole text in a file |
| Other text | The first 200 lines, and a count of the rest. A line end of `\r\n` reads as one; a byte that is not UTF-8 becomes a replacement character |
| An empty body | `(empty body)` |
| A binary body | Its size only, such as `(binary body, 8 bytes)`. A body is binary when a NUL byte is among its first 4096 bytes |
| An answer over 2 MiB | Cut there, and the result says so: `[the answer was cut at 2097152 bytes]`. A JSON body that was cut is shown as text, because it is no longer JSON |
| A redirect | A note that it was not followed, with its `location` header. A `3xx` without a `location` gets no note |
| A write with a `5xx` or `408` answer | A note that it may still have been carried out: check with a `GET` before sending it again. A read, and a write that the server turned down with a `4xx`, get none |

## A folder

`run-folder` returns one line per request, in order, and stops at the first request that does not answer 2xx or that gets no answer.
The requests after it are `skipped`. The failed request follows in full, as `run` would show it.

```text
Folder Smoke in Staging (staging): 2 of 3 ran, stopped at the first failure
1. Health: GET https://api.staging.example.com/health -> HTTP 200 OK
2. Version: GET https://api.staging.example.com/version -> HTTP 503 Service Unavailable
3. Orders: skipped

Failed request:
GET https://api.staging.example.com/version -> HTTP 503 Service Unavailable
Request: Version (flows) in Staging (staging)
...
```

## What is removed

A secret, a token or a sign-in header value that the tool sent, of 8 characters or more, is removed from the answer, in its headers and
in its body, in case a server repeats what it was sent. It becomes `[redacted]`, in each of the forms a server may repeat it: as it is,
inside JSON text, and URL-encoded. The token inside an `Authorization: Scheme token` header is removed on its own as well, because a
server may repeat it without its scheme. A shorter value is left to `jig-core`, because removing it would blank ordinary words.

`Set-Cookie` headers never leave the tool: they are dropped from the answer, also when a transport gives them.

`jig-core` masks production results and cuts long ones.

## What the record carries

The result's details are the request's name, the method and the status. The call's record carries the status as a fact; for a folder,
the number of requests, how many ran, and whether it failed. A call that got no answer carries nothing.
