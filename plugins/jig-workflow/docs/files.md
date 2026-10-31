# Workflow files

What a workflow file holds, how it is checked, where the plugin reads it from, and how a company
supplies its own. Back to the [jig-workflow overview](../README.md).

A workflow is data. The plugin has the fixed list of [conditions](conditions.md) and checks each one
itself, so a file never runs code and a stranger's file can only name stages and conditions.

## The fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The handle you start it by. Letters, digits and `-`, and the same as the file name |
| `description` | no | One line, shown by `/workflow list` |
| `match` | no | `{ "ticket": "<regular expression>" }`, so `start` can leave the name out |
| `branch` | no | The work's branch for `bind`, with `{ticket}` in it. Default `{ticket}` |
| `stages` | yes | At least one, in order |
| `holds` | no | Calls held until a condition holds |

A stage has an `id` (lower-case letters, digits and `-`, unique in the file), a `goal` the agent reads, and
`exit`: the conditions that must all hold before the work leaves it. The last stage usually has no
`exit`, because the work stays there.

A hold has `until`, a condition, and `calls`: a list of tool names, or a tool name and an action, such as
`"git push"`. The condition is checked the same way an exit condition is ([Holds](holds.md)).

## What is checked

A file that does not pass is skipped, and `/workflow list` shows its path and the key at fault. The
others still load. The checks:
- the file is JSON, an object, with no field outside the table, in the file, a stage or a hold;
- `name` matches the file name, and no two stages share an `id`;
- every condition in `exit` and `until` is one of the eight, none twice in one `exit`;
- `match.ticket` and `branch` are usable: a regular expression that compiles, a template with `{ticket}`;
- every entry of `calls` is a tool name, alone or followed by one action.

## Matching a ticket

`start` without a name looks for the workflows whose `match.ticket` matches the ticket key. With exactly
one, it is used. With none or several, `start` lists them and asks for a name. The plugin never starts a
workflow by itself, because starting writes into the ticket folder: when the active ticket has none, the
line at session start says which one matches.

## Where files are read from

In this order; a later file with the same `name` replaces an earlier one, and `/workflow list` says where
each one came from.

1. The folders in `workflow.folders` of `jig.json`.
2. `workflows/` in Pi's agent folder (`~/.pi/agent/workflows/`).
3. `.pi/workflows/` in Pi's working folder, only when Pi trusts the project
   (`ctx.isProjectTrusted()`).

The folders of 1 and 3 are registered with `jig-core` as guarded paths when the session starts, so Pi's
file tools and the sandbox cannot rewrite a workflow file: an agent that could edit the file that holds it
back could lift its own holds. The agent folder is guarded already.

Files are read at session start and on `/workflow reload`. A reload does not change a ticket's state; a
stage that the changed file no longer has is reported by `status`, and the work stays where it is.

## Examples

[`examples/`](../examples/) has three files, generic, with ticket keys like `PROJ-123`. Copy one into a
folder above and change it.

| File | Stages | Holds |
|---|---|---|
| `feature.json` | understand, plan, build, review, deliver, accept, done | no edit or commit before the plan is approved; no push before tests pass at HEAD |
| `bugfix.json` | reproduce, fix, verify, done | no push before tests pass at HEAD |
| `investigation.json` | gather, explain, done | none: it only reads and writes notes |

`feature` ends `deliver` with `pull-request-open` and `checks-pass`, and `accept` with `scenarios-pass`
and `you-approve`.

All three match `PROJ-` keys, so `start` without a name asks which one. When you copy them, give each a
pattern of its own, such as `^BUG-\\d+$` for `bugfix`, and `start` picks by the ticket.

## A company's files

A company plugin ships its own workflows in a folder of its package and tells this plugin where, with
`jig-core`'s section defaults, which work in whatever order the plugins load:

```ts
jig().config.addSectionDefaults("workflow", {
    folders: [path.join(import.meta.dirname, "workflows")],
    tests: { "orders-api": "./gradlew test" },
});
```

Your own `workflow` section is laid over it: an object such as `tests` merges key by key, and a list such
as `folders` is replaced by yours, so list the company's folder again if you set your own. A company file
and a personal one with the same name: the personal one wins, because personal folders are read later.

A company decides its ticket key patterns (`match`), its branch naming (`branch`) and which test
environments count as acceptance environments (in its workflow's goals). This repository holds none of
that.

[Back to the overview](../README.md)
