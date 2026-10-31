# Index check

When a read must use an index, how the plan is read, and what a refusal says. Back to the [jig-mongo overview](../README.md).

A read that scans a whole collection is slow for everyone who uses the database, and a broad scan is how too much data gets read.
In production, `jig-mongo` asks the planner how a read would run before it sends it, and refuses the read when the plan scans the
collection. The agent then rewrites the query.

## Where it applies

- **Production:** on by default.
- **A test environment:** off by default.
- **`requireIndex`** on a connection turns it on or off for that connection (`true` or `false`), whatever its kind.
  - `requireIndex: false` on a production connection is your choice and never the agent's: the agent cannot change `jig.json`.
  - `/jig` says so while it is off: `jig-mongo: the index check is OFF for production (requireIndex: false in your jig.json)`.
  - With several connections in one environment the setting is per connection, and `/jig` names it as `production/billing`.

```json
"production": { "uri": "mongodb://db.example.com:27017", "user": "agent-readonly", "password": "pass:mongo/production",
                "requireIndex": false }
```

## What is asked of the planner

The check runs `explain` at `queryPlanner`: the planner only, nothing is executed and no document is read.

| Action | What is explained |
|---|---|
| `find` | The find, with its filter, projection, sort and limit |
| `count` | The pipeline that counts: `$match` on the filter, then `$group`. With no filter it is refused without asking |
| `distinct` | The pipeline that lists the values |
| `aggregate` | The checked pipeline as it will run, with its limit and the projection an allow list puts in front |
| `sample`, `schema` | With a filter, the `$match` and `$sample`. With none, not checked: a bounded random sample |
| `explain` | At `executionStats` (the default) the server runs the query, so it is checked. At `queryPlanner` it is not |

`databases`, `collections`, `stats`, `indexes` and `index-stats` read no documents and are not checked.

## How the plan is read

- **A scan is a `COLLSCAN`** in a winning plan, wherever the server puts one: under `queryPlanner` for a find, in the `$cursor`
  stage of an aggregation, inside a `$unionWith`, in the slot-based `queryPlan`, or in one shard of many. The plans the planner
  rejected are not what runs, and are left out.
- **An aggregation whose first stage no index serves** shows as a `COLLSCAN` at its cursor: a `$project` first, or a `$group` on a
  field no index covers. A `$group` that an index answers (`DISTINCT_SCAN`) is not a scan.
- **A find with no filter** is a scan, unless a sort an index serves comes with a limit. To see what documents look like, use
  `sample`.
- **A join that reads the joined collection whole** (`EQ_LOOKUP` with a `HashJoin` or `NestedLoopJoin`) is refused too.
- **An answer with no stage in it** is refused: a plan that cannot be read is not shown to use an index.

## Joins the planner does not report

On a server that does not push `$lookup` into the plan, the planner says nothing of the joined collection. So each `$lookup` that
matches on a `foreignField` is also checked against the index list of the joined collection: some index must lead with that field.
`_id` always does.

A `$lookup` written only as a sub-pipeline (`let` and `pipeline`) is checked where the planner reports its plan, and not otherwise
([Not verified yet](not-verified.md)).

## What a refusal says

```text
mongo find production orders.orders: refused, the plan scans the whole collection (COLLSCAN), and reads in production must use an
index. Filter on a field an index leads with: _id, status, createdAt (+2 more; `mongo indexes` lists all).
```

- **The fields** are those that lead an index of the collection, each once, in the order the indexes are listed.
  - At most 5 are named, and the rest are counted.
  - A field that may not be seen under the [access lists](access.md) is neither named nor counted.
  - Text and wildcard indexes lead with no field.
- **No field to name:** the message says that no index leads with a field you may see.
- **A count with no filter** is told to use `stats`, and a find with no filter to use `sample`.
- **A join** names the joined collection and the fields its indexes lead with.

## Reference data

An allow-list entry is a list of fields, or an object with the fields and `"reference": true`. A reference collection is small and
is read whole: it is not checked.

```json
"allow": {
  "orders.orders":    ["_id", "status", "createdAt"],
  "orders.countries": { "fields": ["_id", "code", "name"], "reference": true }
}
```

- **Only the collection marked** is exempt. Another collection of the list is checked, and so is a collection joined to it.
- **A deny list cannot mark one.** A test environment that turns the check on and needs reference data uses an allow list.

## When the check cannot be made

A check that fails is a refusal and never a pass, and nothing is read.

- **The planner fails** (no privilege, a dropped connection, a server error): `refused, the index check could not be made (...)`.
  In production the message holds no text from the server, because it can echo values.
- **A call that is cancelled or runs out of time** is reported as that, as for any call.
- **The index list cannot be read** while a refusal is worded: the refusal stands, without field names.
