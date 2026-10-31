# Not verified yet

What the tests of `jig-logs` do not cover. Back to the
[jig-logs overview](../README.md).

The tests in `test/` run against a fake Elasticsearch on 127.0.0.1, a fake Loki on
127.0.0.1 and a fake transport. The tests in `test/it/` run the same code against
real backends, in the `integration` job of CI (see [Integration
tests](../../../docs/integration-tests.md)); what they prove is listed first.

## Verified in CI

Elasticsearch 9.5 and 8.19, OpenSearch 3.9 and 2.19, and Loki 3.7, each as a container with its
version printed in the log. The suites run once on each line: Elasticsearch 9 and OpenSearch 3 in the
latest run, Elasticsearch 8 and OpenSearch 2 in the previous one (see [Integration
tests](../../../docs/integration-tests.md#the-matrix)). `test/it/suite.ts` holds the tests every backend must pass.

| What | Proved by |
|---|---|
| Phrase and `query` search; the window and its exclusive end; relative windows | `suite.ts`, all three |
| Windows cut into hour and day buckets, searched from either end | `suite.ts`, all three |
| Paging with `size`, `offset` and `order`; `match`, `exclude`, `around`, `chars` | `suite.ts`, all three |
| A JSON body cut for length, and said to be cut | `suite.ts`, all three |
| A list `filter` as Elasticsearch `terms` and as a Loki regular expression that matches the whole value | `suite.ts`, `loki.test.ts` |
| The check for data, with a count on Elasticsearch and without one on Loki | `suite.ts`, all three |
| A production environment's lines through `jig-core`'s own masker, none withheld | `suite.ts`, all three |
| The `format` on the time range, a time stored as epoch milliseconds, fields named in the configuration | `elasticTests` in `suite.ts` |
| `analyze_wildcard`, the 25 second search timeout and the `size: 0` check | `elasticTests` and `suite.ts` |
| Basic sign-in, an API key and a sign-in service, over HTTPS with a certificate authority of its own | `elasticsearch.test.ts` |
| A wrong password (401), a user without access (403), a missing index | `elasticsearch.test.ts`, `elasticTests` |
| The tenant header, and Loki's 401 without it | `loki.test.ts` |
| Loki's two limits: a window that is too long is halved until it fits or is a gap, and too many lines stop the search | `loki.test.ts` |
| Phrases with quotes, backslashes, brackets and regular expression characters | `loki.test.ts` |
| A query Loki rejects, and one the check refuses before it is sent | `suite.ts`, `loki.test.ts` |
| Requests carried by a transport to a node that speaks plain HTTP | `opensearch.test.ts`, `loki.test.ts` |

## What is still not verified

## Every backend

- **A bearer token against a real server.** Elasticsearch's token service needs a
  licence above the free one, so only Basic, an API key and a sign-in service were
  run.
- **Masking of the lines, at scale.** A line is cut so that no JSON body or quoted
  value is left open, because `jig-core`'s masker withholds a line it cannot read.
  The integration tests pass the real result of a production search through the real
  masker, and it withholds nothing. A random test outside this plugin cut about 41 000
  lines of nested JSON, escaped JSON and `key="value"` text, and the masker withheld
  none of them; the suite does not run that one.
- **What `jig-core` does when classifying throws.** An unknown environment, and a
  Loki query that could reach beyond the selector, throw a `TypeError` from the
  declaration.
  - `jig-core`'s `classify.ts` turns a `TypeError` into an invalid-input block, and
    its gate blocks the call with "Blocked by jig-core: logs cannot run with this
    input: ..." and records it as `invalid`, without asking.
  - Any other error blocks with "jig-core could not decide".
  - This was read in `jig-core`'s code and tested with a fake, not run in a
    session. `execute` refuses the same call the same way.
  - The message the model reads names the environments that exist.

## Elasticsearch and OpenSearch

- **Managed services and other versions.** Elasticsearch 9.5 and 8.19, and OpenSearch 3.9 and 2.19, were
  run in CI. Amazon OpenSearch Service, Elastic Cloud, Elasticsearch 7 and OpenSearch 1 were
  not, nor were requests signed with AWS credentials.
- **A reply that reports a timeout or lost shards.** The reply shapes come from the
  search API; a single node never times out or loses a shard, so the halving for them
  is tried only against the fake.

## Loki

The fake Loki was written from Loki's documentation as it stood on 2026-10-30
(the `latest` pages, a Loki 3 release). Loki 3.7 now runs in CI, which settled most of
what follows; a different version may still word an error differently or answer a
parameter differently. What is proved is in the table above. What the adapter relies
on, and the page that says it:

- **`GET /loki/api/v1/query_range`** takes `query`, `limit` (default 100), `start`
  (included), `end` (excluded) and `direction` (`forward` or `backward`, default
  `backward`). An epoch value is in nanoseconds. Page: [Loki HTTP
  API](https://grafana.com/docs/loki/latest/reference/loki-http-api/).
- **A log query is answered** with `data.resultType` `streams` and `data.result[]`
  of `stream` (the labels) and `values` (pairs of a nanosecond epoch string and a
  line), each stream sorted by time. Page: [Loki HTTP
  API](https://grafana.com/docs/loki/latest/reference/loki-http-api/).
- **A query is a stream selector,** then an optional pipeline. Pages:
  [LogQL](https://grafana.com/docs/loki/latest/query/) and
  [Log queries](https://grafana.com/docs/loki/latest/query/log_queries/).
  - Line filters are `|=`, `!=`, `|~` and `!~`.
  - Matching is case-sensitive; `(?i)` before a regular expression ignores case.
  - A backtick string needs no escapes, and `` `\w+` `` is `"\\w+"`.
- **The limits** are on the pages [Configuration](https://grafana.com/docs/loki/latest/configure/)
  and [Configuration limits](https://grafana.com/docs/loki/latest/configure/loki-limits/).
  - `max_entries_limit_per_query` is 5000 by default.
  - `max_query_length` is 30d1h (721 hours), and a longer query is rejected.
  - `query_timeout` is 1 minute.
- **The tenant** is the header `X-Scope-OrgID`. With `auth_enabled: false` there is
  one tenant, `fake`, and the header is not needed. Without the header in
  multi-tenant mode a request fails with 401. Page:
  [Multi-tenancy](https://grafana.com/docs/loki/latest/operations/multi-tenancy/).
- **The errors** are on the page
  [Troubleshoot queries](https://grafana.com/docs/loki/latest/operations/troubleshooting/troubleshoot-query/).
  - All HTTP 400, and not retryable until the query changes: "the query time range
    exceeds the limit", "max entries limit per query exceeded", parse errors,
    "queries require at least one regexp or equality matcher".
  - Also HTTP 413 "response larger than the max message size", HTTP 504 "context
    deadline exceeded", HTTP 503 "index not ready", HTTP 401 "no org id".
- **Grafana Cloud** uses basic authentication with the user of the stack's Loki
  details and an API token. Page:
  [Python client examples](https://grafana.com/docs/loki/latest/reference/python-client-examples).

What the documentation does not say, and CI settled on Loki 3.7:
- **A search is a GET,** and `limit` may be 1. Both work. A gateway that limits the
  length of an address (often 8 KiB) would still refuse a very long call as a 4xx,
  which the result calls a rejected query; no gateway was tried.
- **The escapes of a double-quoted string are Go's.** A phrase with quotes and
  backslashes finds its line. `\uXXXX` for control characters is not reached, because
  a phrase has none.
- **`limit` counts lines across streams,** and the adapter merges the streams by time.
  Three services in one environment come back in time order, page after page.
- **A `=~` label matcher is anchored,** so a list in a `filter` matches whole values.
- **`match` and `exclude` ignore case** on Loki as they do on Elasticsearch.

What is still assumed:
- **Comments.** The pages read do not mention `#` comments. The check on a `query`
  reads everything outside a quoted string as code, so a comment cannot hide a `{`
  from it, whether or not Loki has comments.
- **A third part of a line,** structured metadata, may follow the time and the
  line. Loki 3.7 sent two parts; a node that sends metadata was not run.
- **The wording of errors differs between versions.** They are matched loosely on
  the phrases of the troubleshooting page, and only on a 400 or a 413. The 400s for
  a window that is too long and for too many lines were seen; the 413, 503 and 504
  were not.
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
- **Grafana Cloud.** Basic authentication with a stack's user and token was not tried;
  the node in CI has tenants and no sign-in.
