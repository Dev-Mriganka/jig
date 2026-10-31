# Configuration: the `jira` section

The fields of the `jira` section of `jig.json`, in detail. The tables are in the
[jig-jira overview](../README.md#configure). Back to the overview.

- **`site`** may have a path, but no user name, password, query or fragment.
  Plain `http` is refused.
- **`auth`** is exactly one of the four forms in the overview. A token is a
  secret reference, never the token itself.
- **`projects`:** up to 50 project keys, such as `["PROJ", "OPS"]`, written in any
  case and kept in upper case. A key is a letter, then letters, digits and `_`, up
  to 20 characters. Yours replaces a company's list whole.
  - **`search` without `jql`** looks in these projects, newest first: `project in
    ("PROJ", "OPS") ORDER BY updated DESC`. The result names the query it ran.
    With `jql` the query is sent as written, and with no `projects` a search
    still needs `jql`.
  - **`create` accepts only these projects.** Another project is refused before
    anyone is asked or Jira is called, and the message lists the ones allowed.
    With no `projects`, `create` takes any project.
- **`updateFields`:** up to 100 fields, by name or id. `create` may set any
  field on the create screen.
- **`fields`:** a name is 1 to 60 characters and cannot be one the tool already
  knows. Friendly names work in `fields`, `include` and `updateFields`.
- **`createDefaults`:** up to 30 fields, each a name and the value to give it, such
  as `{ "Priority": "Medium", "Components": ["Web"], "Story Points": 1 }`. It is
  applied to `create` for each field the call does not set.
  - **Names** are resolved as a field in a `create` call's `fields` is: a name the
    tool knows, a friendly name from `fields`, or a field's name or id on the create
    screen. Case does not matter.
  - **Values** are checked as the call's own are, against what the create screen
    allows. A value the screen refuses stops the `create` and says it comes from
    `createDefaults`; setting the field in the call is the way out.
  - **A field the call sets** (an empty value included) is never defaulted. A
    default for a field that is not on the issue type's screen is left out, and the
    preview says so.
  - **In the preview** a default shows as `Priority: Medium (from your defaults)`.
    It goes into the request, so changing it while you read voids the approval.
  - **Not allowed:** `project`, `issuetype` and `summary`, which the call sets.
- **`privateNames`:** up to 100 folder or host names that are flagged in
  outgoing text (see [Writes](writes.md)).
- **`environment`:** letters, digits, `_` and `-`, starting with a letter, up to
  40 characters.
