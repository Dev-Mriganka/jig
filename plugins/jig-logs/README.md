# jig-logs: searching logs

**Status: built.** This README is the specification, and the code follows it.
The tests run against a fake search server on 127.0.0.1 and a fake transport.
Nothing has been tried against a real OpenSearch or Elasticsearch yet (see "Not
verified yet").

## Tool: `logs`

One tool that searches the logs of an OpenSearch or Elasticsearch index. It
only reads. Its parameters:

| Parameter | Default | What it does |
|---|---|---|
| `phrase` or `query` | one of them is needed | `phrase`: an exact phrase in the message, such as a trace id, an account id or an error text (1 to 512 characters). `query`: a Lucene query over the message, with `AND`, `OR`, `NOT`, wildcards and quotes (1 to 2000 characters) |
| `environment` | needed | Where to search: one of the environments in the configuration. A name nobody configured is refused, and the message lists the ones that exist |
| `window` | `2h` | A relative window that ends now: `30m`, `2h` or `1d`, at most `7d`. Not together with `from` and `to` |
| `from`, `to` | none | Exact times: ISO 8601 with a timezone, given together, `to` exclusive, at most 7 days apart |
| `size` | 50 | How many hits to fetch, 1 to 200 |
| `order` | `asc` | `asc` fetches the oldest hits of the window, `desc` the newest |
| `match`, `exclude` | none | 1 to 5 plain texts of 1 to 200 characters, not patterns. A hit is shown only if its message contains all of `match` and none of `exclude`, ignoring case. They choose among the hits already fetched and never change the search |
| `around` | none | One plain text. Each hit is shown as a window around the first place the text occurs in it, instead of its first characters |
| `chars` | 300, or 4000 when 3 or fewer hits are shown | How many characters a hit keeps, 40 to 4000. With `around`, the size of the window |
| `offset` | 0 | Which hit to start from among the fetched ones (the ones that pass `match` and `exclude`, when those are given). A page holds up to 20 hits, fewer when `chars` is large |

A call that names a parameter the tool lacks, leaves out `environment`, gives
both `phrase` and `query`, or gives a value out of range is refused before
anything is sent. The message is one line and shows the right form, such as
`logs does not use limit. Usage: logs {phrase or query, environment, window?, ...}`.

## What a result looks like

Plain text: a header, then what is missing or worth knowing, then one line per
hit, `time message`. This is `order: "desc"`, `size: 3`, `exclude: ["Heartbeat"]`,
`around: "C-1204"` and `chars: 160` on a trace id:

```text
prod 2026-10-16T09:30:00Z..2026-10-16T10:30:00Z: complete, 412 hits, 3 fetched (newest first), 2 shown, 1 bucket
{…} is a JSON body cut for length, not hidden: rerun with chars: 4000 (or around: "<term>") to see it; in production, personal values are masked and IDs are kept.
2 of 3 fetched hits contain none of 1 exclude term (case-insensitive, fetched hits only). The window holds 412 hits and only 3 were fetched, so more may exist: narrow the window or search for something more exact, and search again.
Hits 1-2 of 2 matching hits, none after these:
2026-10-16T10:28:13.500Z …"price":19.99},{"chargeNumber":"C-1204","quantity":4,"price":19.99},{"chargeNumber":"C-1205","quantity":4,"price":19.99}, {…}
2026-10-16T10:27:56.500Z …"price":19.99},{"chargeNumber":"C-1204","quantity":4,"price":19.99},{"chargeNumber":"C-1205","quantity":4,"price":19.99}, {…}
```

- **The header** gives the environment, the window, the status, how many hits
  the window holds, how many were fetched and how many are shown, and how many
  buckets were searched. `at least 412 hits` is a lower bound.
- **The status** is `complete` when every part of the window was searched,
  `partial` when some parts were not, and `failed` when none was.
- **`Gaps:` and `Next:`** name the parts that were not searched, why, and what
  to change. Neighbouring gaps with the same reason read as one.
- **`Availability:`** appears when nothing was found. See below.
- **`{…}` and `[…]`** stand for a JSON body that did not fit the line. A line
  says so once: it is cut for length, not hidden. Rerun with `chars: 4000`, or
  with `around` and a term from inside the body.
- **The texts of `match`, `exclude` and `around` are never repeated** in the
  result: a text that opens a JSON body would make `jig-core`'s masker replace
  the line that repeats it.

## How a window is searched

- **Buckets.** A window of up to 6 hours is one request. Longer windows are
  searched in hour buckets up to 2 days and in day buckets above, so a week is
  7 requests. Buckets are searched one after another, starting from the end of
  the window that `order` names, and once `size` hits are collected the
  buckets that remain only count.
- **A bucket that fails is halved and tried again.** That covers a backend that
  gives up (it is told to after 25 seconds), a request cut at 30 seconds, a
  reply that reports lost shards, an HTTP 408 or 5xx, and a connection that
  breaks. A half is halved again, 4 times at most. What still fails is a gap in
  the result. The answer of a bucket that was halved is thrown away, so no hit
  is counted twice. An HTTP 429, or a reply that is too large or not a search
  result, is a gap too, without halving, and the search goes on.
- **A call makes at most 64 requests and starts none after 150 seconds.** The
  windows it did not reach are gaps with the reason `request_budget` or
  `time_budget`.
- **A problem that every window would have is an error,** not a result made of
  gaps: a sign-in the backend refuses (401 or 403), a redirect, an address
  nobody answers. A query the backend rejects (any other 4xx, such as a 400
  for Lucene it cannot read) or an index it does not have (404) stops the
  search after the first request; the result is `failed`, and says why.
- **Nothing found.** One more request counts the documents of the window that
  have the environment's filter, without the phrase or query. The
  `Availability:` line then says whether the window holds any documents at all.
  It proves nothing about how long logs are kept.

## Rules

- **It only reads.** A search is a read in the `jig-core` environment that the
  searched environment's `jigEnvironment` names. A production read is allowed,
  and `jig-core` masks the result. This plugin masks nothing itself, and a name
  that `jig-core` does not know counts as production.
- **What the model writes is a value and nothing else.** Every request body is
  built in one place, from a short list of parts: a time range, the
  environment's filter, and one `match_phrase` or `query_string`. The text of a
  call is only ever the phrase or the query string. It cannot add a script, an
  aggregation, a field, another index or paging by `from`.
- **No credential in anything the model reads.** A secret is resolved when a
  request is made and stays in that call. An error names what failed (a status,
  an error code) and never repeats a header, a body, an address or the reply.
- **A bad environment is invalid input.** `jig-core` classifies the call
  before it runs; an environment nobody configured gives a `TypeError` that
  lists the ones that exist, and nobody is asked.

## Backends

The search is `POST <url>/<index>/_search` with a JSON body. There is one
request function, and everything above it (the query, the buckets, the reading
of replies) does not know which way a request travels:

- **Directly,** over HTTPS, signed in with one of four kinds of `auth`.
  Redirects are not followed, so a credential never goes to an address the
  configuration did not name.
- **Through a transport** that a company plugin registered. Every request goes
  to `jig().transports.request(name, { system: "logs", method: "POST", url,
  headers, body })`, and no authorization header is added: the transport signs
  in.

Each request has 30 seconds, whichever way it travels. A transport that ignores
its signal does not hold the call longer. The 30 seconds do not run while a
secret is being unlocked or a sign-in service is working.

| `auth` | What is sent |
|---|---|
| `{ "username": "reader", "password": "pass:logs/reader" }` | `Authorization: Basic ...` |
| `{ "apiKey": "pass:logs/key" }` | `Authorization: ApiKey <the secret>`. The secret is the key as Elasticsearch gives it (`encoded`) |
| `{ "token": "pass:logs/token" }` | `Authorization: Bearer <the secret>` |
| `{ "signIn": "corp-sso" }` | the headers of the sign-in service of that name, asked for on every request |

A secret reference is resolved once per call, by `jig-core`, and only through a
backend that its `secrets.backends` allows. A mistake in a reference never
repeats the value.

## Configure

In `~/.pi/agent/jig.json`, under `logs`. `backend` and `environments` are both
needed. `jig-core` reports an unknown or invalid field, and the tool then says
it is not configured instead of running half set up.

| Field | Meaning |
|---|---|
| `backend` | Exactly one of two shapes: `{ "url", "auth" }` for a direct request, or `{ "transport", "url" }` for one through a transport. `url` is where the backend is, without the index. A direct `url` must be `https://`; a transport's may be `http://` or `https://`. It may hold a path, and must not hold a user name, a password, a query string or a fragment |
| `backend.auth` | One of the four kinds in the table above. A password, key or token is always a secret reference (`pass:...`, `env:...`), never the secret |
| `environments` | A map from the name the tool uses to that environment's settings, at least one |
| `environments.<name>.index` | The index name or pattern, such as `app-logs-*`. Several can be listed with commas |
| `environments.<name>.timeField` | The date field that windows and sorting use. Default `@timestamp` |
| `environments.<name>.messageField` | The text field that `phrase` and `query` search and that hits show. Default `message`. A dotted name such as `log.message` works whether the documents nest it or not |
| `environments.<name>.filter` | Fields that must equal a value, for an index that holds several environments, such as `{ "env.keyword": "prod" }`. Every entry is an exact `term`, so name a keyword field. At most 8 entries |
| `environments.<name>.jigEnvironment` | The `jig-core` environment this search is classified in, which decides masking and rules. Default: the name itself |

```json
{
  "logs": {
    "backend": {
      "url": "https://search.example.com:9200",
      "auth": { "apiKey": "pass:logs/api-key" }
    },
    "environments": {
      "staging": { "index": "app-staging-*" },
      "prod": {
        "index": "app-*",
        "filter": { "env.keyword": "prod" },
        "jigEnvironment": "production"
      }
    }
  }
}
```

## Company part (in the company plugin)

- the backend's address, as `backend.url`;
- the indexes, as `environments.<name>.index`;
- how environments map to the log's own environment names, as `filter`, and to
  `jig-core` environments, as `jigEnvironment`;
- the sign-in: a `signIn` service, or a transport, that the company plugin
  registers with `jig-core`.

## Limits

| What | Limit |
|---|---|
| Window of one call | 7 days; older logs are read in slices |
| Hits fetched | 1 to 200 per call, 50 by default |
| Hits on one page | 20, fewer when `chars` is large (24 000 characters in all) |
| One request | 30 seconds; the backend is told to stop at 25 |
| One call | 64 requests, and no new request after 150 seconds |
| A bucket | halved at most 4 times |
| A reply | 16 MiB |
| `chars` | 40 to 4000 |

## Not in this plugin

- **Backends other than the `_search` API,** such as SQL or query languages of
  other products, and requests signed with AWS credentials. They are written
  when a job needs them, not in advance.
- **Anything that changes data,** and aggregations, dashboards, saved searches
  and following a log as it grows.
- **A company's environment names, addresses and sign-in.** They are the
  settings above, set by the company plugin.

## Not verified yet

- **A real OpenSearch or Elasticsearch.** The request bodies follow the search
  API and an earlier harness that ran them against OpenSearch, but these parts
  are new and have never run against a real backend: the `format` on the time
  range, `analyze_wildcard` on a Lucene query, the 25 second search timeout, the
  check for data as a `size: 0` search (the earlier harness used a count),
  fields named in the configuration, and the `term` filter.
- **Each kind of `auth` against a real server,** and TLS with a certificate
  authority of its own. The tool uses Node's certificate store, so
  `NODE_EXTRA_CA_CERTS` applies to it as to the rest of Pi.
- **Masking of the lines.** A line is cut so that no JSON body or quoted value
  is left open, because `jig-core` withholds a line it cannot read. A random
  test outside this plugin cut about 41 000 lines of nested JSON, escaped JSON
  and `key="value"` text, and `jig-core`'s masker withheld none of them; cutting
  the same messages with a plain slice made it withhold them at once. The
  test suite does not run it, because a plugin reaches `jig-core` only through
  its contract.
- **What `jig-core` does when classifying throws.** An unknown environment
  throws a `TypeError` from the declaration. `jig-core`'s gate blocks a call
  whose classification throws with "jig-core could not decide: ..." and
  records it as `internal`; `invalid` is the record kind for a preview that
  throws. The message the model reads names the environments that exist. This
  was read in `jig-core`'s code and tested with a fake, not run in a session.
  `execute` refuses the same call the same way.

## Layout

```text
jig-logs/
  src/
    index.ts        the plugin: the tool, and through withJig its declaration and the logs section
    tool.ts         the logs tool: its description, its classification, and execute
    params.ts       the schema, the usage line, and the checks on a call
    config.ts       the logs section: validation, defaults, the environment a call names
    request.ts      the one request function: direct with its auth, or through a transport
    search.ts       the buckets, the halving, the budgets, and the check for data
    query.ts        every request body, in one place
    time.ts         windows, instants, buckets
    response.ts     reading replies
    failure.ts      why a request failed and what to do next
    summary.ts      the result text
    line.ts clip.ts one hit as a line: its fields, the excerpt around a term, the cut that keeps JSON whole
    values.ts       small helpers
  skills/   logs/SKILL.md: how to search (an identifier first, a narrow window, then wider)
  test/     against a fake search server, a fake transport and a fake jig-core; golden request bodies in test/golden
```
