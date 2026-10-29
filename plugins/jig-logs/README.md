# jig-logs: searching logs

**Status: design.**

## Tool: `logs`

One tool that searches logs. It only reads. Its parameters:

| Parameter | What it does |
|---|---|
| `phrase` or `query` | An exact phrase (a trace id, an account id, an error text), or a query with AND, OR and wildcards |
| `environment` | Where to search; the backend maps it to its own index and environment names |
| `window`, or `from` and `to` | A relative window such as `30m` or `2h` (at most 7 days), or exact times |
| `size`, `order` | How many hits to fetch (1 to 200), oldest or newest first |
| `match`, `exclude` | Plain texts a hit must contain, or must not contain |
| `around`, `chars` | Show each hit around a term, with this many characters |
| `offset` | Paging through the hits |

Long windows are searched in hour or day buckets, and a bucket that times out
is split and retried.

## Rules

- Production logs are masked like every production result.

## Backends

The search runs through a backend interface. The first backend is
Elasticsearch through Kibana, configured by the company plugin. Other backends
are written when a job needs them, not in advance.

## Company part (in the company plugin)

- the backend's address;
- the indexes;
- how environments map to the log's own environment names;
- the sign-in.

## Layout (planned)

```text
jig-logs/
  src/      the tool, the bucketed search, sample selection, the backend interface
  test/     against a fake search server
```
