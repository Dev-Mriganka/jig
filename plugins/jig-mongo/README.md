# jig-mongo: MongoDB, with reads, writes, indexes and aggregation

**Status: design.**

`jig-mongo` gives the agent a complete MongoDB tool: exploring, querying,
indexes, query plans, aggregation and writes. `jig-core` decides each call by
environment: reads run, a write to `staging` asks you with a preview, and every
write to production is denied. What the agent may see is set by an allow list
or a deny list. For example, to debug a stuck order the agent runs `count`, then
`find` on `orders.orders` in `staging`. It then runs `explain` to see whether
the query used an index, and `update` to fix the test document, after you
approve the preview.

## Tool: `mongo`

| Group | Action | Kind | What it does |
|---|---|---|---|
| Explore | `databases`, `collections` | read | What exists, minus everything denied |
| | `schema` | read | Field names and types, from a sample |
| | `stats` | read | Sizes and counts of a collection or database |
| Indexes | `indexes` | read | The indexes of a collection |
| | `index-stats` | read | How often each index is used (`$indexStats`) |
| | `explain` | read | The plan of a query: which index, documents examined, time |
| Query | `count`, `find`, `distinct`, `sample` | read | Documents, with filter, projection, sort and limit |
| Aggregation | `aggregate` | read, or write | The full pipeline. With `$out` or `$merge` it is a write |
| Write | `insert`, `update`, `replace`, `delete`, `bulk` | write | Changes documents. `update` and `delete` take `one` or `many` |
| Index changes | `create-index`, `drop-index` | write | Changes indexes |

Filters, documents and pipelines are Extended JSON, such as `{"$oid": "..."}`.
A result that reaches its limit (1 to 2000, default 20) is marked "possibly
partial".

## Access: an allow list or a deny list

| | Test environments | Production |
|---|---|---|
| Default | **Deny list:** everything is readable except what you list | **Allow list:** nothing is readable until you list it |
| Why | Test data is there to be explored | A new sensitive collection is never shown by accident |

- **Always denied, in every environment:** the system databases (`admin`,
  `local`, `config`), and fields whose names look like credentials
  (`*password*`, `*secret*`, `*token*`, `*apiKey*`). You can add to these, never
  remove them.
- **Lists reach fields, not only collections.**
  - `find` strips denied fields from every result. In production it returns
    only allowed fields, as a forced projection.
  - `aggregate` is refused before it runs when it names a denied field anywhere.
    That includes a rename such as `{ x: "$password" }`, a `$lookup` into a
    denied collection, and `$replaceRoot`.
- **A denied collection cannot be written either.**

## Rules

- **Writes are previewed with a count.** The preview shows the filter, the
  change, and how many documents it touches, counted just before. If that count
  changes before the write runs, the write is refused as "changed since the
  preview".
- **Guards on writes:**
  - an `update` or `delete` with an empty filter is refused;
  - `many` above 1000 documents needs a `limit` you raise on purpose.
- **Server-side JavaScript is refused** (`$where`, `$function`,
  `$accumulator`), unless you allow it for a test environment.
- **A lost reply is never resent.** One read checks what happened.
- **Production is read-only and masked,** whatever the configuration says.

## Configure

In `~/.pi/agent/jig.json`, under `mongo`:

```json
{
  "mongo": {
    "connections": {
      "staging":    { "uri": "mongodb://db.staging.example.com:27017", "user": "agent", "password": "pass:mongo/staging" },
      "production": { "uri": "mongodb://db.example.com:27017", "user": "agent-readonly", "password": "pass:mongo/production",
                      "via": { "ssh": { "host": "bastion.example.com", "user": "agent", "key": "pass:ssh/bastion" } } }
    },
    "access": {
      "staging":    { "deny":  ["billing.cards", "*.notes"] },
      "production": { "allow": { "orders.orders": ["_id", "status", "items", "createdAt"] } }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `connections` | Per environment: a URI with no credentials in it, the user, the password as a secret reference, and an optional route (`via`): an SSH bastion, or a company tunnel |
| `access` | Per environment: `deny` (a list of `db.collection` or `*.field` patterns) or `allow` (collections with their fields). Production must use `allow` |

Use a read-only database user for production. The floor denies writes anyway,
but the user is the second lock.

## Company part (in the company plugin)

- its connections and routes, such as a tunnel through its own jump hosts;
- its allow lists for production;
- credentials, as secret references.

## Later

- **Saved queries,** run by name, for queries a team wants to share.
- **Change streams,** watching a collection for a while.

## Layout (planned)

```text
jig-mongo/
  src/      the tool, access lists, pipeline checks, write previews, connections and routes
  skills/   mongo/SKILL.md: count, then find; explain before blaming the database; preview every write
  test/     against a local MongoDB
```
