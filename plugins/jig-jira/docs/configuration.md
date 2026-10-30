# Configuration: the `jira` section

The fields of the `jira` section of `jig.json`, in detail. The tables are in the
[jig-jira overview](../README.md#configure). Back to the overview.

- **`site`** may have a path, but no user name, password, query or fragment.
  Plain `http` is refused.
- **`auth`** is exactly one of the four forms in the overview. A token is a
  secret reference, never the token itself.
- **`updateFields`:** up to 100 fields, by name or id. `create` may set any
  field on the create screen.
- **`fields`:** a name is 1 to 60 characters and cannot be one the tool already
  knows. Friendly names work in `fields`, `include` and `updateFields`.
- **`privateNames`:** up to 100 folder or host names that are flagged in
  outgoing text (see [Writes](writes.md)).
- **`environment`:** letters, digits, `_` and `-`, starting with a letter, up to
  40 characters.
