# Query grammar: what a search sends to Elasticsearch

What a `logs` call asks an Elasticsearch or OpenSearch backend, and what the
model's text can reach. What it asks Loki is on the [Loki](loki.md) page. Back to
the [jig-logs overview](../README.md).

## The request body

Every body is built in one place, `src/backends/elasticsearch.ts`, from one short
list of parts:

```text
{ size, timeout, track_total_hits, query: { bool: { filter: [...], must: [...] } }, sort, _source }
```

| Part | What it holds |
|---|---|
| `size` | How many hits this request still wants |
| `timeout` | `25s`: the backend gives up on a shard search after this |
| `track_total_hits` | `true`, so totals are exact |
| `filter` | The time range, then one `term` or `terms` per entry of the environment's `filter` |
| `must` | One clause: a `match_phrase` for a `phrase`, or a `query_string` for a `query` |
| `sort` | The time field, in the call's `order`, with `unmapped_type: date` |
| `_source` | The time field and the message field, and nothing else |

- **`size`:** once `size` hits are collected, the buckets that remain ask for 0 and
  only add their exact total.
- **`timeout`:** the backend answers with what it has, marked `timed_out`. It is
  shorter than the 30 seconds one request may take, so the backend's answer comes
  before the tool's own timeout cuts the connection.
- **`track_total_hits`:** a backend that counts only up to a limit reports a lower
  bound, and the result says "at least".

- **`filter`:** an entry with one value is a `term`. An entry with a list is a
  `terms`, which a document matches when its field equals any of the values, so
  `"namespace.keyword": ["orders", "billing"]` finds the documents of either. A list
  holds 1 to 50 values.

`sort` and `_source` are left out when `size` is 0. The time range is a `range`
on the environment's `timeField`, from `gte` the start to `lt` the end, with
`format: strict_date_optional_time`. The format makes the bounds mean ISO
instants whatever date format the field was mapped with.

This is a phrase search of `production`, on an index that holds several
environments:

```json
{
  "size": 50,
  "timeout": "25s",
  "track_total_hits": true,
  "query": {
    "bool": {
      "filter": [
        { "range": { "@timestamp": { "gte": "2026-10-13T10:00:00Z", "lt": "2026-10-13T12:00:00Z", "format": "strict_date_optional_time" } } },
        { "term": { "env.keyword": "production" } }
      ],
      "must": [{ "match_phrase": { "message": "req-7f3a9c" } }]
    }
  },
  "sort": [{ "@timestamp": { "order": "asc", "unmapped_type": "date" } }],
  "_source": ["@timestamp", "message"]
}
```

## Phrase or query

| | `phrase` | `query` |
|---|---|---|
| Becomes | `{ "match_phrase": { "<messageField>": "<phrase>" } }` | `{ "query_string": { "query": "<query>", "default_field": "<messageField>", "analyze_wildcard": true } }` |
| Syntax | None: matched as a phrase | Lucene: `AND`, `OR`, `NOT` in capitals, quotes, wildcards, fields such as `level:ERROR` |
| Use it for | One identifier or an exact error text | Terms that are combined |

`analyze_wildcard` lets `Timeout*` find the lower-cased terms that a text field
stores, as Kibana's own search does.

## What the model's text can reach

The text of a call lands in one value only: the phrase of a `match_phrase`, or
the string of a `query_string`. It never becomes a key, a field name or a clause
of its own. So a call cannot add a script, an aggregation, a field, another index
or paging by `from`. Field names, the index and the environment's filter come
from configuration, a list of values included.

`test/golden/` holds the exact bodies for a phrase search, a query on a shared
index, a bucket that only counts, and the check for data. A test builds every
combination the builder can make and checks that each stays inside this grammar.

## The check for data

The body of the check for data (see [Windows and buckets](windows-and-buckets.md#when-nothing-is-found))
has `size: 0`, the time range and the environment's filter, lists included. It has no `must`, no
`sort` and no `_source`, so it never carries the phrase or the query:

```json
{"size":0,"timeout":"25s","track_total_hits":true,"query":{"bool":{"filter":[{"range":{"@timestamp":{"gte":"2026-10-13T10:00:00Z","lt":"2026-10-13T12:00:00Z","format":"strict_date_optional_time"}}},{"term":{"env.keyword":"production"}}]}}}
```
