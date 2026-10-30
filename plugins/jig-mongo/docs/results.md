# Results

What the model is shown, and what is recorded. Back to the [jig-mongo overview](../README.md).

## Extended JSON in and out

Filters, documents, updates and pipelines are Extended JSON. The typed values are checked while the call is classified, so a bad one is
blocked before anything connects, and turned into BSON only where the driver is called:

| Written as | Becomes |
|---|---|
| `{"$oid": "65f1..."}` | ObjectId |
| `{"$date": "2026-01-31T09:00:00Z"}` or `{"$date": {"$numberLong": "..."}}` | Date |
| `{"$numberInt"}`, `{"$numberLong"}`, `{"$numberDouble"}`, `{"$numberDecimal"}` | the typed number |
| `{"$uuid"}`, `{"$binary"}`, `{"$timestamp"}`, `{"$regularExpression"}`, `{"$minKey"}`, `{"$maxKey"}`, `{"$ref", "$id"}` | the typed value |
| a whole number beyond 32 bits | a 64-bit integer; a smaller one stays a plain number |
| `{"$regex": "^a", "$options": "i", "$exists": true}` | left as the query operators they are |

Results come back as relaxed Extended JSON, so an `_id` or a date can be pasted into the next filter: `{"$oid": ...}`, `{"$date": ...}`,
`{"$numberDecimal": ...}`, and `{"$numberLong": ...}` for an integer JSON cannot hold. A few values are shown as a note instead, so
they cannot flood the context: binary data as `<binary 3 bytes>`, code as `<code 5 characters>`.

## The text of a result

A header line with the call and what came back, then one line of JSON for each document or value. Each line is valid JSON, because
`jig-core` masks production results field by field. The text is cut at a whole document when it passes about 40,000 characters, and the
header says `showing the first N`. A result at its limit says `possibly partial (limit 20 reached; narrow the filter or raise limit)`.

```text
mongo find staging orders.orders: 2 documents, possibly partial (limit 2 reached; narrow the filter or raise limit)
{"_id":{"$oid":"65f1f1f1f1f1f1f1f1f1f1f1"},"status":"open"}
{"_id":{"$oid":"65f1f1f1f1f1f1f1f1f1f1f2"},"status":"stuck"}
```

| Action | Shows |
|---|---|
| `count` | `42 documents match (exact)` |
| `distinct` | the values, one per line, up to the limit |
| `sample` | a random sample of documents |
| `schema` | `status: string\|null (in 18 of 20)` for each field path, with `[]` for array elements: types and counts, never values. Sampled with the BSON type of each number kept. `limit` is the sample size |
| `stats` | the numbers of the collection (`count`, `size`, `avgObjSize`, `storageSize`, `nindexes`, `totalIndexSize`) or of the database |
| `indexes`, `index-stats` | one line per index: name, keys, options, and for `index-stats` how many times it was used and since when |
| `explain` | the plan as `FETCH > IXSCAN(status_1)`, a warning for `COLLSCAN`, the rejected plans, and with `executionStats` (the default) documents returned, keys and documents examined, and the time |

## The record

`jig-core` records the call with its action, environment and effect, and the tool adds numbers only: `returned` or `matched` for a
read, `matched`, `modified`, `deleted` and `inserted` for a write. The details of a result hold the action, the environment and counts,
never documents.
