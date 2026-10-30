# Writes

How a write is previewed, compared with what was approved, sent once, and checked when its reply is lost. Back to the
[jig-mongo overview](../README.md).

## Where a write may happen

| Environment | What happens |
|---|---|
| a test environment | `jig-core` asks, with the preview below |
| production | refused when the call is classified, before anything is asked. `jig-core`'s floor denies it as well |

A write is `insert`, `update`, `replace`, `delete`, `bulk`, `create-index`, `drop-index`, and an `aggregate` whose last stage is `$out`
or `$merge`. Nothing in a write is sent until the call has been planned: the collection, every field it names and every operator are
checked first, and an invalid call is blocked without asking.

## The preview

| Action | The preview shows |
|---|---|
| `update`, `replace`, `delete` | the filter, the change, how many documents match now (counted just before), what the write changes, and the cap |
| `insert` | the first 10 documents and how many more |
| `bulk` | the operations, and for each one how many documents match |
| `aggregate` with `$out` or `$merge` | the pipeline, how many documents reach the output stage, and how many the target has now (`$out` replaces it) |
| `create-index`, `drop-index` | the keys and options, or the index and its definition, and the indexes there are |

The count is `countDocuments` with a limit one past the cap, so a huge collection is not counted whole. The preview has a fingerprint
(a SHA-256 of the request and every count). It is read back with `approvedPreview` when the call runs.

## "Changed since the preview"

When the call runs, the counts are read again. If the fingerprint differs from the one that was approved, nothing is sent:

```text
mongo update staging orders.orders: changed since the preview (it was 12 documents match; now 13 documents match). Nothing was changed; run it again to see the new preview.
```

Ids made for documents with none are not part of the fingerprint, so an `insert` does not change between preview and run.

## Guards

- **An empty filter** in `update`, `replace`, `delete` or a bulk operation is refused: it would change every document.
- **The cap:** `which: "many"` may touch 1000 documents. `limit` raises it on purpose, up to 2000, and lowers it too: it is the most the
  write may touch. A filter that matches more is refused, and so is a `bulk` whose operations together touch more, an `insert` of
  more documents, and an `$out` or `$merge` that writes more. `limit` with `which: "one"` is refused.
- **A filter that matches nothing** is refused: there is nothing to approve.
- **Not supported:** upserts, array filters and collations. A bulk operation or an `update` that names them is refused.

## The write is sent once

The driver's retryable writes are off, so it never sends a write again. If the reply is lost, the tool does not send it again either.
What it knows depends on where the call ended:

| What happened | The model is told |
|---|---|
| The route, the connection or the sign-in failed, or a count before the write failed | `Nothing was changed.` |
| The server rejected the write of one document, or one index change | `Nothing was changed.` |
| The server rejected a write of many | `Part of it may have been carried out. It was not sent again.` and the result of one read |
| The reply was lost, the server's time limit ran out, or the call's time ran out | `no answer (...). The outcome is unknown: the server may have carried it out. It was not sent again.` and the result of one read |

The one read, on a new connection with a short time limit:

| Write | The read |
|---|---|
| `insert` | how many of the inserted documents are present, by `_id` |
| `update`, `replace`, `delete` | how many documents the filter matches now, against how many matched before |
| `bulk` | the same, for each operation that has a filter (at most 10) |
| `$out`, `$merge` | how many documents the target has now |
| `create-index`, `drop-index` | the names of the indexes now |

If that read fails too, the message says so and tells the model to read the data. Either way the model must not send the write again
without looking.

## The record

`jig-core`'s record of the call gets the facts `matched`, `modified`, `deleted` and `inserted`, whichever apply, and for a read
`returned` or `matched`. Never a document.
