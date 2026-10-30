# Not verified yet

What the tests of `jig-logs` do not cover. Back to the
[jig-logs overview](../README.md).

The tests run against a fake Elasticsearch on 127.0.0.1, a fake Loki on 127.0.0.1
and a fake transport. Nothing has been tried against a real backend.

## Every backend

- **Each kind of `auth` against a real server,** and TLS with a certificate
  authority of its own.
- **Masking of the lines.** A line is cut so that no JSON body or quoted value is
  left open, because `jig-core` withholds a line it cannot read. A random test
  outside this plugin cut about 41 000 lines of nested JSON, escaped JSON and
  `key="value"` text, and `jig-core`'s masker withheld none of them; cutting the
  same messages with a plain slice made it withhold them at once. The test suite
  does not run it, because a plugin reaches `jig-core` only through its contract.
- **What `jig-core` does when classifying throws.** An unknown environment, and a
  Loki query that could reach beyond the selector, throw a `TypeError` from the
  declaration. `jig-core`'s `classify.ts` turns a `TypeError` into an invalid-input
  block, and its gate blocks the call with "Blocked by jig-core: logs cannot run
  with this input: ..." and records it as `invalid`, without asking. Any other
  error blocks with "jig-core could not decide". This was read in `jig-core`'s
  code and tested with a fake, not run in a session. `execute` refuses the same
  call the same way. The message the model reads names the environments that exist.

## Elasticsearch and OpenSearch

- **A real OpenSearch or Elasticsearch.** The request bodies follow the search
  API and an earlier harness that ran them against OpenSearch, but these parts
  are new and have never run against a real backend: the `format` on the time
  range, `analyze_wildcard` on a Lucene query, the 25 second search timeout, the
  check for data as a `size: 0` search (the earlier harness used a count),
  fields named in the configuration, and the `term` filter.

## Loki

The fake Loki was written from Loki's documentation as it stood on 2026-10-30
(the `latest` pages, a Loki 3 release). No Loki ran. A different version may word
an error differently or answer a parameter differently.

What the adapter relies on, and the page that says it:

| Fact | Page |
|---|---|
| `GET /loki/api/v1/query_range` takes `query`, `limit` (default 100), `start` (included), `end` (excluded) and `direction` (`forward` or `backward`, default `backward`). An epoch value is in nanoseconds | [Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/) |
| A log query is answered with `data.resultType` `streams` and `data.result[]` of `stream` (the labels) and `values` (pairs of a nanosecond epoch string and a line), each stream sorted by time | [Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/) |
| A query is a stream selector, then an optional pipeline. Line filters are `\|=`, `!=`, `\|~` and `!~`. Matching is case-sensitive; `(?i)` before a regular expression ignores case. A backtick string needs no escapes, and `` `\w+` `` is `"\\w+"` | [LogQL](https://grafana.com/docs/loki/latest/query/) and [Log queries](https://grafana.com/docs/loki/latest/query/log_queries/) |
| `max_entries_limit_per_query` is 5000 by default; `max_query_length` is 30d1h (721 hours) and a longer query is rejected; `query_timeout` is 1 minute | [Configuration](https://grafana.com/docs/loki/latest/configure/) and [Configuration limits](https://grafana.com/docs/loki/latest/configure/loki-limits/) |
| The tenant is the header `X-Scope-OrgID`. With `auth_enabled: false` there is one tenant, `fake`, and the header is not needed. Without the header in multi-tenant mode a request fails with 401 | [Multi-tenancy](https://grafana.com/docs/loki/latest/operations/multi-tenancy/) |
| Errors, all HTTP 400 and not retryable until the query changes: "the query time range exceeds the limit", "max entries limit per query exceeded", parse errors, "queries require at least one regexp or equality matcher". Also HTTP 413 "response larger than the max message size", HTTP 504 "context deadline exceeded", HTTP 503 "index not ready", HTTP 401 "no org id" | [Troubleshoot queries](https://grafana.com/docs/loki/latest/operations/troubleshooting/troubleshoot-query/) |
| Grafana Cloud uses basic authentication with the user of the stack's Loki details and an API token | [Python client examples](https://grafana.com/docs/loki/latest/reference/python-client-examples) |

What was not found in the documentation, so it is assumed:
- **A search is a GET.** The `query_range` section describes parameters in the
  address and says nothing of a POST. A very long call puts a few thousand
  characters in the address, and a gateway that limits the length of one (often
  to 8 KiB) would refuse it as a 4xx, which the result calls a rejected query.
- **`limit` is at least 1.** The page gives only its default. The adapter never
  sends 0, and a bucket that only counts asks for 1.
- **The escapes of a double-quoted string are Go's.** Only the equivalence above
  was found. The adapter writes `\\`, `\"` and `\uXXXX` for control characters.
- **Comments.** The pages read do not mention `#` comments. The check on a `query`
  reads everything outside a quoted string as code, so a comment cannot hide a `{`
  from it, whether or not Loki has comments.
- **`limit` counts lines across streams,** and the lines of different streams are
  merged by time by the adapter, since Loki sorts inside a stream only.
- **A third part of a line,** structured metadata, may follow the time and the
  line in newer versions. It is not read.
- **The wording of errors differs between versions.** They are matched loosely on
  the phrases of the troubleshooting page, and only on a 400 or a 413.
- **A window past `max_query_lookback`.** The configuration page says the range is
  trimmed, and the troubleshooting page lists a 400, "this data is no longer
  available". Trimmed, the search finds nothing; as a 400 it reads as a rejected
  query. Neither says anything about retention, which the availability line says too.
- **HTTP 429** is described for tail requests only. For a search it is handled as
  for every backend: that window is a gap, and it is not halved.
- **A tenant id** may hold more than visible characters in some deployments. The
  check allows visible ASCII only, up to 300 characters.
- **Equal times.** Lines of different streams with the same time keep the order
  Loki sent their streams in.
- **Case.** `match` and `exclude` are sent as `\|=` and `!=`, which are
  case-sensitive, so the fetch is narrower than the view that shows them.
