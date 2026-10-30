# Loki: how a call becomes a query

How `jig-logs` searches Grafana Loki: what to configure, what a call turns into,
what the model's `query` may be, how a reply is read, what Loki cannot give, and
what its errors mean. Back to the [jig-logs overview](../README.md). What was read
in Loki's own documentation, and what was not, is in
[Not verified yet](not-verified.md#loki).

## Configure

```json
{
  "logs": {
    "backend": {
      "type": "loki",
      "url": "https://logs.example.com",
      "auth": { "username": "12345", "password": "pass:logs/loki-token" },
      "tenant": "orders"
    },
    "environments": {
      "staging": { "selector": "{app=\"orders-api\", env=\"staging\"}" },
      "production": { "selector": "{app=\"orders-api\", env=\"production\"}" }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `backend.type` | `"loki"` |
| `backend.url` | Where Loki is, without `/loki/api/v1`. It may hold a path, such as a gateway's prefix |
| `backend.auth` | Any of the four kinds (see [Connecting](connecting.md)) |
| `backend.tenant` | Optional. Sent as the header `X-Scope-OrgID` on every request |
| `environments.<name>.selector` | Required. A LogQL stream selector with at least one `=` or `=~` matcher that has a value |
| `environments.<name>.filter` | Optional. Labels that must equal a value, or one of a list: matchers added to the selector |

- **`backend.auth`:** for Grafana Cloud use `username` and `password`: the user
  shown in the Loki details of the stack, and an API token as a secret reference.
  Behind a gateway, `token` or `signIn`.
- **`backend.tenant`:** it is sent through a transport too. Without it a Loki that
  has several tenants answers 401, "no org id". A Loki with `auth_enabled: false`
  has one tenant, `fake`, and needs none. Up to 300 visible characters; `a\|b`
  names two tenants.
- **`selector`:** it names the streams of the environment, and it comes from here
  and never from the model.
- **`filter`:** up to 8 labels, each with one value or a list of 1 to 50, such as
  `{ "namespace": ["orders-api", "billing-api"], "region": "eu" }`. A value is text, a
  number, `true` or `false`, and a label is a name the selector can read (letters,
  digits and `_`, so no dots). It comes from here and never from the model.

An environment has no `index`, `timeField` or `messageField`: they are
Elasticsearch's, and Loki has a time and a line and nothing to choose. A field of
the other type is reported by name.

## What a call becomes

One request for each bucket:
`GET <url>/loki/api/v1/query_range?query=...&start=...&end=...&limit=...&direction=...`

| Parameter | Value |
|---|---|
| `query` | The selector, then the filters below |
| `start`, `end` | The bucket in nanoseconds since the epoch. `start` is included and `end` is not, as for every bucket |
| `limit` | The hits still wanted, at least 1 and at most 5000 |
| `direction` | `forward` for `order: "asc"`, `backward` for `desc` |

| In the call | In the query |
|---|---|
| (the environment) | its `selector`, with the matchers of its `filter` added |
| `phrase` | `\|~ "(?i)<phrase>"` |
| `match` | one `\|~ "(?i)<text>"` for each text |
| `exclude` | one `!~ "(?i)<text>"` for each text |
| `query` | the text itself, last |

The text is matched literally: every regular-expression character in it is
escaped. `(?i)` makes the filter ignore case, as the tool does on every
backend; Loki's own `|=` and `!=` would not.

This is a search for the phrase `req-7f3a9c`, with `match: ["timeout"]` and
`exclude: ["Heartbeat"]`, in `staging`:

```text
{app="orders-api", env="staging"} |~ "(?i)req-7f3a9c" |~ "(?i)timeout" !~ "(?i)Heartbeat"
```

`test/golden/loki-*.json` holds the exact parameters for each shape.

The texts are quoted strings: the backslash, the quote and every control
character in them are escaped, so nothing in a phrase, a `match` or an `exclude`
can close the string.

The address carries the parameters encoded, so a text with `&` in it is still one
value of `query`. The line filters come before the model's `query`, so Loki drops
lines before it parses them.

The parameters are in the address, as Loki's documentation shows them. So a
sign-in service, a transport and a gateway in front of Loki see the query, as they
would from any other Loki client; with Elasticsearch it is in the body.

## What a filter becomes

Each entry of an environment's `filter` is a matcher put inside the selector's
braces, after its own matchers. One value is `label="value"`. A list is one regular
expression with each value escaped as a line filter's text is: `namespace=~"orders|billing"`.
A label matcher has to match the whole value, so that finds a stream whose
`namespace` is exactly `orders` or `billing`, and no other.

```text
{app="orders-api", env="staging", namespace=~"orders|billing", region="eu"} |~ "(?i)req-7f3a9c"
```

A number or a flag is written as its text, and case counts, as for any label.
The check for data asks the same streams.

## What the model's `query` may be

A `query` is a LogQL pipeline that is appended after the selector, such as
`|= "timeout" | json | level="error"`. Because it follows the selector it cannot
replace it, as long as it cannot open another one. So a `query` is refused unless:
- it starts with `|`;
- it holds no `{` outside a quoted string (double quotes with backslash escapes, or
  backticks), so `line_format "{{.msg}}"` is fine and `or {app="other"}` is not;
- every quote closes, and it is one line of printable characters.

Everything outside a quoted string is read as code, which is never less than Loki
reads as code, so a comment cannot hide a `{` from the check.

A refused `query` is an `InputError`, a `TypeError`. It is raised when the call is
classified, so `jig-core` blocks the call with the message and does not ask; the
request builder checks again, so no request is ever made from a query nobody
checked. Elasticsearch has no such check: its query text only ever lands in one
value of the request.

## Reading a reply

A reply holds the lines of one or more streams, each sorted by time. The hits are
all the lines, merged and sorted by time in the direction asked. A hit keeps its
time as an ISO instant with the digits Loki gave (3, 6 or 9 after the second), its
line, and the labels of its stream; hit lines show the time and the line only.

A reply that is not log lines (HTML from a gateway, a `matrix` result, a line
without a time) is not read at all and becomes an `invalid_response` gap, so a hit
is never dropped quietly.

## What Loki cannot give

Loki answers a log query with lines and no count. So:
- **The total of a bucket is the number of lines returned,** exact when that is
  fewer than `limit`, and a lower bound ("at least") when the limit was filled.
- **A bucket after the hits are collected asks for one line.** For Elasticsearch it
  asks for the count; Loki has none to give, and one line tells that the bucket
  holds something. The total then reads "at least".
- **The check for data** asks the selector and its filter, and nothing the model
  wrote, over the whole window, for one line. The availability line then says that
  the window holds documents, without a number.

`match` and `exclude` are sent to Loki and applied again to the hits that come
back, ignoring case both times, so `match: ["timeout"]` also finds a line that
only says `Timeout`.

## Limits

| Limit | Value used | In Loki |
|---|---|---|
| Lines in one query | 5000 | `max_entries_limit_per_query`, default 5000 |
| Time range of one query | 721 hours | `max_query_length`, default 30d1h |

The tool asks for at most 200 hits and 7 days, so neither is reached on a default
Loki. An operator may have set them lower; the next section says what happens then.

## What Loki's errors mean

Loki words most errors in plain text with an HTTP 400. The result never repeats
them; it says the reason, and what to change (see
[Failures](failures.md#gaps-and-their-reasons)).

| Loki answers | The result says | Then |
|---|---|---|
| 400 "the query time range exceeds the limit" | `window_too_long` | The bucket is halved and tried again, like a timeout |
| 400 "max entries limit per query exceeded" | `response_too_large` | The search stops: every bucket asks for as many lines. Lower `size` |
| 413 "response larger than the max message size" | `response_too_large` | That window is a gap |
| 400 for a parse error, or a selector that can match everything | `query_rejected` | The search stops |
| 404 | `index_not_found` | The search stops: `backend.url` may be wrong |
| 429 | `rate_limited` | That window is a gap |
| 504 "context deadline exceeded", 408 | `timeout` | The bucket is halved |
| 5xx, such as 503 "index not ready", or a broken connection | `upstream_unavailable` | The bucket is halved |
| 401 | an error | It names `backend.auth` and `backend.tenant`: "no org id" means the tenant is missing |
| 403 | an error | Signing in again will not help |

A halved bucket counts in the header as "split after a timeout", whatever made it
split.
