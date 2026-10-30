# Failures, and what the messages say

What a call refuses, what stops it with an error, and the reasons behind a gap in
a result. Back to the [jig-logs overview](../README.md).

## Refused before anything is sent

Every call is checked first. A mistake is a one-line `TypeError` that starts with
the tool's name and says how to put the call right. A value in it is quoted and
cut to 40 characters. No secret is read and no request is made.

- **A parameter the tool lacks:** `logs does not use limit. Usage: logs {phrase or
  query, environment, window?, from?, to?, size?, order?, match?, exclude?, around?,
  chars?, offset?}`
- **Neither `phrase` nor `query`:** `logs needs phrase or query. Usage: ...`
- **Both:** `logs takes phrase or query, not both. Usage: ...`
- **No `environment`, or one nobody configured:** `logs needs environment: one of
  staging, production` or `logs: unknown environment "uat"; use one of staging,
  production`
- **The tool is not configured:** `logs is not configured: add a "logs" section with
  "backend" and "environments" to jig.json, or fix the errors /jig shows for it`
- **A text that is empty, only spaces, too long or not printable:** `logs: phrase
  must be 1-512 printable characters, not only spaces`, and the same for `query`,
  `match`, `exclude` and `around` with their own limits. A control character has no
  place in a search term.
- **A number out of range:** `logs: size must be an integer from 1 to 200 (got
  201)`, and the same for `chars` and `offset` with their own ranges. `offset` goes
  up to 1 000 000, which is only a sanity bound: an `offset` past the fetched hits
  is answered in the result.
- **`match` or `exclude` not 1 to 5 texts:** `logs: match must list 1 to 5 texts`
- **A `query` for Loki that could reach beyond the stream selector:** it is refused
  when the call is classified, so `jig-core` blocks it without asking (see
  [Loki](loki.md#what-the-models-query-may-be)). The messages are:
  - `logs: a Loki query must start with |, such as |= "timeout" or | json | level="error"`
  - `logs: a Loki query cannot hold { outside quotes: the stream selector is set in jig.json`
  - `logs: a Loki query has a quote that is never closed`
  - `logs: a Loki query must be one line of printable characters`
- **A `window` that is not `30m`, `2h` or `1d`, or is over 7 days:** `logs: window
  must look like 30m, 2h or 1d and be at most 7d; for older logs pass from and to in
  slices of at most 7 days (got "9d")`
- **`from` and `to`:** one of
  - `logs: from and to must be given together`
  - `logs: give either window or from and to, not both`
  - `logs: to must be after from`
  - `logs: from..to must span at most 7 days; search older logs in slices of at most 7 days`
  - `logs: from must be ISO 8601 with a timezone, such as 2026-10-13T09:30:00Z (got "2026-10-13")`
- **An `order` that is not `asc` or `desc`:** `logs: order must be asc or desc (got
  "sideways")`

## Errors that stop a call

A problem that every window would have is an error and not a result made of
gaps, because a result of nothing but gaps would only hide it. No message holds a
header, a body, an address or a credential.

- **The backend refuses the sign-in (HTTP 401):** `The backend did not accept the
  sign-in (HTTP 401): sign in again, or check backend.auth in the logs section of
  jig.json`. For Loki it names `backend.auth and backend.tenant`, as a Loki with
  several tenants answers 401 to a request without one.
- **The backend denies access to the index (HTTP 403):** `The backend denied this
  sign-in access to the index (HTTP 403): signing in again will not help, so ask for
  access to it`. For Loki it says "the logs".
- **A redirect (HTTP 3xx):** `The backend answered with a redirect (HTTP 302): set
  backend.url to the address it redirects to`
- **An address nobody answers:** `cannot reach the backend (ECONNREFUSED): check
  backend.url, the network and the certificate`. Only the system error code is
  kept, never the error's own text.
- **A secret, a sign-in service or a transport that `jig-core` cannot use:**
  `jig-core`'s own message.
  - A service or a transport that is not registered gets one that names those that
    are.
  - A transport that fails gets `transport "<name>" failed: ...`.
  - A message about a secret never holds the reference or a value.
- **You stop the call:** it ends at once, between buckets or in the middle of a
  request, and makes no further request.

## Gaps and their reasons

A problem with one window becomes a gap, and the search goes on. `Gaps:` names the
window and its reason, and `Next:` says what to change. A bucket is halved and
tried again for the reasons marked in the Halved column, because a smaller
request may get past them (see
[Windows and buckets](windows-and-buckets.md#when-a-bucket-fails)).

| Reason | When | Halved |
|---|---|---|
| `timeout` | A request cut at 30 seconds, or HTTP 408 or 504 | yes |
| `search_timeout` | The backend gave up and marked its reply `timed_out` | yes |
| `failed_shards` | The reply reports lost shards | yes |
| `upstream_unavailable` | HTTP 5xx other than 504, or a connection that broke | yes |
| `rate_limited` | HTTP 429 | no |
| `response_too_large` | A reply over 16 MiB (for Loki also HTTP 413 or a 400 "max entries") | no |
| `window_too_long` | Loki's 400 "the query time range exceeds the limit" | yes |
| `invalid_response` | A reply that is not a search result, such as an HTML page from a gateway | no |
| `query_rejected` | Any other 4xx answer (not 401, 403, 404, 408 or 429) | no |
| `index_not_found` | HTTP 404, or an `index_not_found_exception` in any other answer | no |
| `request_budget`, `time_budget` | The call used its requests or its time | no |
| `not_run` | The window was skipped after an earlier rejection | no |

- **`response_too_large` for Loki:** a 400 "max entries limit per query exceeded"
  stops the search.
- **`window_too_long`:** the window is longer than the `max_query_length` that
  Loki's operator set.
- **`query_rejected`:** for example a 400 for Lucene or LogQL the backend cannot
  read.

### The `Next:` lines

- **`timeout`, `search_timeout`:** Narrow the window or search for a more exact
  phrase, then retry.
- **`failed_shards`:** Some shards failed, so counts are a lower bound; retry later
  or narrow the window.
- **`upstream_unavailable`, `rate_limited`:** The backend was unavailable or busy;
  retry once, then report the gap instead of guessing.
- **`response_too_large`:** Lower size or narrow the window.
- **`window_too_long`:** The backend does not search a window this long in one
  request; use a shorter window.
- **`invalid_response`:** The backend sent a reply that is not a search result; retry
  once, then report the gap.
- **`query_rejected`:** The backend rejected the query; for query check the Lucene
  syntax (AND, OR and NOT in capitals, quotes around phrases), otherwise use phrase.
  For Loki it names the LogQL syntax instead.
- **`index_not_found`:** The index was not found: the environment's index in the logs
  section of jig.json may be wrong. For Loki a 404 means the address is wrong: "The
  backend answered 404: backend.url in the logs section of jig.json may be wrong, as
  Loki serves /loki/api/v1/query_range."
- **`request_budget`, `time_budget`:** Too much for one call; narrow the window, or
  search the missing windows separately.
- **`not_run`:** Skipped after an earlier rejection; fix that first.

A rejected query, a missing index and, for Loki, a request for more lines than it
gives fail every window alike, so they stop the search after the first request. The
other windows are `not_run`, and the status is `failed`. This is a rejected Lucene
query over three days:

```text
staging 2026-10-10T12:00:00Z..2026-10-13T12:00:00Z: failed, no window could be searched
Gaps: 2026-10-10T12:00:00Z..2026-10-11T12:00:00Z query_rejected; 2026-10-11T12:00:00Z..2026-10-13T12:00:00Z not_run
Next: The backend rejected the query; for query check the Lucene syntax (AND, OR and NOT in capitals, quotes around phrases), otherwise use phrase.
Next: Skipped after an earlier rejection; fix that first.
```

The backend's own words are never repeated, because a rejected query's text
repeats the query.
- **Elasticsearch:** only the class name of an error, such as
  `index_not_found_exception`, is read, to tell a missing index from a rejected
  query.
- **Loki:** its plain text is read only for the phrases of its two limits, on a 400
  or a 413, to tell a limit from a rejected query.
- **A rejected Loki query** gets this `Next:` line: `The backend rejected the query;
  for query check the LogQL syntax (it starts with |, as in |= "text" or | json |
  level="error"), otherwise use phrase.`
