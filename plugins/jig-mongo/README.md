# jig-mongo: MongoDB reads

**Status: design.**

## Tool: `mongo`

All actions are reads.

| Action | What it does |
|---|---|
| `describe` | What may be read, so nothing is guessed. In production: the approved collections and fields. In test environments: the collections |
| `count` | The exact number of matching documents. Start here |
| `find` | Documents, with optional projection, sort and limit |
| `distinct` | Up to `limit` distinct values of one field |
| `aggregate` | A restricted pipeline: `$match`, `$sort` on one field, inclusion `$project`, `$unwind`, `$limit`, `$skip` |

Parameters:
- `environment`;
- the database family or service;
- `filter`, in Extended JSON (for example `{"$oid": "..."}`);
- `limit`, from 1 to 2000 (default 20). A result that reaches it is marked
  "possibly partial".

## Rules

- **Production reads** are limited to approved collections and fields, and the
  results are always masked (see `jig-core`).
- **No writes.** A data fix in production is a plan that a person runs, never
  the agent.

## Company part (in the company plugin)

- **Connection routes per environment:**
  - a connection URI with no credentials in it;
  - a transport: direct, an SSH SOCKS tunnel through a jump host, or an AWS SSM
    port forward.
- **The approved collections and fields** for production.
- **How a service's database name is found,** for example from the running
  service.
- **Connection credentials,** as secret references (see
  [Secrets](../../docs/secrets.md)).

## Layout (planned)

```text
jig-mongo/
  src/      the tool, query checks, connection and tunnel handling
  skills/   mongo/SKILL.md: how to explore safely (describe, count, then find)
  test/     against a local test database
```
