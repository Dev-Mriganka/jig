# jig-http: calling APIs

**Status: design.**

## Tool: `http`

One call to a named target:

| Parameter | What it does |
|---|---|
| `target` | A named API from configuration. The target decides the environment and the sign-in |
| `method` | `GET` reads; `POST`, `PUT`, `PATCH`, `DELETE` write |
| `path` | Checked for allowed characters; no `..`, including percent-encoded |
| `body` | Any JSON value, at most 256 KiB; not for `GET` |
| `headers` | At most 10. Headers that carry sign-in or control the connection are refused |

## Rules

- **Writes** follow the rules table. A write to a test environment asks you by
  default, and production writes are denied by the floor.
- **Sign-in** is added by the tool, never typed by the model.

## Company part (in the company plugin)

- **The named targets:**
  - their base addresses;
  - whether one sits behind a jump host or is called from inside the cluster;
  - their environments.
- **Each target's sign-in:** none, a bearer token, an HMAC signature or an
  OAuth password grant, with secrets as references.

## Layout (planned)

```text
jig-http/
  src/      the tool, request checks, sign-in kinds
  test/     against a local fake server
```
