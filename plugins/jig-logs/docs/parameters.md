# Parameters: every parameter of `logs`

The limits and details that the table in the [jig-logs overview](../README.md#tool-logs)
leaves out. Back to the overview.

## What is searched

- **`phrase`:** an exact phrase in the message, such as a trace id, an account id
  or an error text (1 to 512 characters).
- **`query`:** a query in the backend's language, such as `AND`, `OR`, `NOT` and
  wildcards in Lucene, or `|= "timeout" | json` in LogQL (1 to 2000 characters).
- **`environment`:** one of the environments in the configuration. A name nobody
  configured is refused, and the message lists the ones that exist.
- **`window`:** `30m`, `2h` or `1d`, at most `7d`. Not together with `from` and
  `to`.
- **`from`, `to`:** ISO 8601 with a timezone, `to` exclusive, at most 7 days apart.
- **`size`:** 1 to 200. The hits fetched are what `match`, `exclude`, `around`,
  `chars` and `offset` then choose among.
- **`order`:** `asc` fetches the oldest hits of the window, `desc` the newest.

## How the fetched hits are shown

- **`match`, `exclude`:** 1 to 5 plain texts of 1 to 200 characters, not patterns.
  A hit is shown only if its message contains all of `match` and none of
  `exclude`, ignoring case.
- **`around`:** one plain text. Each hit is shown as a window around the first
  place the text occurs in it, instead of its first characters.
- **`chars`:** 40 to 4000. The default is 300, or 4000 when 3 or fewer hits are
  shown. With `around`, it is the size of the window.
- **`offset`:** which hit to start from among the fetched ones that pass `match`
  and `exclude`. The default is 0. A page holds up to 20 hits, fewer when `chars`
  is large (see [Hit lines](hit-lines.md#choosing-and-paging-hits)).

A wrong call is refused before anything is sent (see [Failures](failures.md)).
