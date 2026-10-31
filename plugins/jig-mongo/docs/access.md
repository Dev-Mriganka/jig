# Access

What the agent may see, and how that is enforced. Back to the [jig-mongo overview](../README.md).

## The two lists

| | Deny list | Allow list |
|---|---|---|
| Where | Test environments, by default | Production, and required there |
| A collection or field is visible | unless a pattern denies it | only if the list names it |
| A new collection | visible at once | hidden until listed |

A test environment may use an allow list too. A production environment may not use a deny list: that is an error when the section is
checked, and again when a call is made, because `jig-core` decides which names are production.

## Several connections

An environment that has [several connections](connections.md#several-connections-in-one-environment) has its rules per connection:
`access.<environment>` is a map by the connection's name, and each entry is a deny or an allow list as above.

```json
"access": {
  "staging":    { "orders": { "deny": ["*.notes"] }, "billing": { "deny": ["cards.*"] } },
  "production": { "orders": { "allow": { "orders.orders": ["_id", "status"] } } }
}
```

- **A rule applies to its connection only.** The deny list of `orders` does not touch `billing`.
- **A connection with no entry** has the default of its kind: nothing denied in a test environment, nothing readable in
  production.
- **Production needs an allow list for each connection,** and no JavaScript, as for one connection.
- **One list for the whole environment is refused,** and so is a name that is no connection there: the message says which.
- **An environment with one connection** keeps the shape it had: `access.<environment>` is the list itself.

## Patterns of a deny list

| Pattern | Denies |
|---|---|
| `db.collection` | the collection |
| `db.*` | every collection of the database |
| `*.field` | the field in every collection, at any depth |
| `db.collection.field` | the field in that collection. A dotted path is one field: `*.profile.ssn` |

A pattern of three or more parts is also read as a collection named `a.b`, because a collection name may hold dots. Denying both errs on
the safe side.

A field pattern matches wherever its names appear one after another in a path, so `*.notes` denies `notes` and `customer.notes`,
and `*.profile.ssn` denies `profile.ssn` and `customer.profile.ssn.last4`.

## The allow list

`{ "orders.orders": ["_id", "status", "items.sku"] }`. A listed field includes what is under it: `status.code` is allowed, and `items`
is allowed in part only (`items.sku`). The key is `db.collection`, and the collection may hold dots. A list may not be empty, and may
not name a credential-like field.

An entry can also be an object, `{ "fields": ["_id", "code"], "reference": true }`, which marks a small collection of reference
data. The [index check](index-check.md#reference-data) lets it be read whole. `fields` is required, and no other key is allowed.

## Always denied

These hold in every environment, and a configuration can add to them but never remove them:

- the databases `admin`, `local` and `config`, in any letter case;
- collections named `system.*`;
- any field with `password`, `secret`, `token` or `apiKey` in its name, in any case. This reaches a name used as a filter, a
  projection, a sort, the name of a new field, and any depth of a result.

## What each action does with the lists

- **`find`, `sample`, `distinct`, `schema`:** every field named in the call is checked, a denied one is refused, and the result is
  stripped of denied fields at any depth, through arrays, whatever the server sent. With an allow list:
  - the request has a forced inclusion projection of the allowed fields;
  - a requested field that is not allowed is refused;
  - a field that is only partly allowed expands to the allowed fields under it;
  - excluding fields (`{"status": 0}`) is refused.
- **`indexes`, `index-stats`:** an index on a field that may not be seen is left out, and the count says so. The condition of a partial
  index names fields, so it is not shown.
- **`databases`, `collections`:** only what the lists allow.
- **`stats`:** of a collection that may be seen. The statistics of a whole database count every collection in it, listed or not: sizes
  and counts, never names.
- **Writes:** a denied collection is refused. A field a write names is checked like a filter, because what a write reports (matched
  and modified counts) could otherwise be used to probe the value of a denied field.

## How a pipeline is walked

A pipeline is checked in full before anything runs. A field reference is a `"$path"` string, a `"$$variable.path"`, the key of a
`$match`, `$sort` or `$project`, or the name of a field a stage creates.

| It is refused | Because |
|---|---|
| a reference to a denied field, in any stage, nested expression or sub-pipeline | the value would be read |
| a rename: `{ x: "$password" }`, `$addFields`, `$group` accumulators, and more (below) | the value would be copied under another name |
| `$getField` or `$setField` with a computed name | the name cannot be checked |
| `$objectToArray` | it turns field names into values |
| `$lookup`, `$graphLookup`, `$unionWith` into a denied collection, or by a denied field | the collection and its fields are checked like the pipeline's own |
| `$replaceRoot` or `$replaceWith` with a denied field or document | the new root would carry it |
| a `$facet` branch that names a denied field | every sub-pipeline is walked |
| `$jsonSchema`, `$text` (with an allow list), a query or stage operator the walk does not know | it names fields that cannot be checked |
| a field name that looks denied, even as a new name | choose another name |
| `$out` or `$merge` anywhere but last, or into a collection that may not be written | writes are previewed and checked |

- **A rename** also covers `$sortByCount`, `$bucket`, `$setWindowFields` and `$redact`.
- **A `$replaceRoot` or `$replaceWith`** is refused with a denied field, or with a whole document that holds a denied path.
- **`$out` or `$merge`** is also refused in a sub-pipeline.

A variable stands for what it was given: `$map`, `$filter`, `$reduce` and `$let` bind `$$name` to the path of their input, so
`$$line.token` is `items.token`. A variable that is not defined is refused.

### With an allow list

- Every reference must be to an allowed path, as a whole: a field listed in part cannot be copied, compared or sorted whole. It can be
  unwound or kept.
- A name the pipeline made up (`$addFields`, a `$project` that computes, a `$lookup` `as`, anything after `$group`) holds derived data
  and may be used by later stages. `$$ROOT` and `$$CURRENT` alone are refused.
- A projection of the allowed fields is put in front of the stages, after the leading `$match` stages that an index can serve, and in
  front of every `$lookup` and `$unionWith` on the collection it reads. A `$lookup` without a pipeline gets one for this
  (MongoDB 5.0 or later). So even a reference the walk missed reads nothing that is not listed.
- `$graphLookup` is refused: it cannot be limited to listed fields.

## JavaScript

`$where`, `$function`, `$accumulator`, `$code` and `$scope` are refused anywhere in a call, unless the environment's `access` entry says
`"javascript": true`. Production never allows it: that setting is an error there. When it is allowed, the arguments of `$function` are
still checked.
