# State

What `workflow.json` holds, who can write it, and what switching, going back and concurrent sessions do to
it. Back to the [jig-workflow overview](../README.md).

Each ticket has at most one workflow, and its state is one file in the ticket folder that `jig-memory`
keeps: `<ticket folder>/<KEY>/workflow.json`, mode 0600. The folder is the `memory` section's `folder`, by
default `~/.local/share/jig/tickets`. The file survives Pi restarts, so evidence recorded last week still
counts if the commit it names is still HEAD.

## What is in it

| Field | Holds |
|---|---|
| `workflow`, `ticket` | The name of the workflow file, and the ticket key |
| `stage`, `stageSince` | The current stage's id, and when it began |
| `notesAtStage` | The hash of `notes.md` when the stage began |
| `history` | Each start, advance and back, with the time |
| `plan` | The approved fingerprint, the time, the number of scenarios |
| `scenarios` | By number: the result, the evidence (kind and reference), the time, the scenario's hash |
| `tests` | By repository folder: the last result ([Tests](tests.md)) |
| `reviews` | The `jig-review:approved` events that cover commits: review id, time, folders and commits |
| `ci` | The `jig-ops:ci-finished` results: folder, commit, outcome, time (the last 20) |
| `observed` | The last `gh pr view` reading per repository: pull request, head, checks, time |

The workflow's stages and conditions are not copied into the file. The name points at the file that
`/workflow list` shows, so fixing a workflow file mid-ticket takes effect at the next reload. If the file
is gone, or no longer has the stage, `status` says so and the work stays where it is; holds from a
workflow that cannot be found are not enforced, and the status line says that too.

## Who writes it

Only this plugin. It is a guarded path: the plugin registers it with `jig-core` (`config.addProtectedPaths`)
when the workflow starts, and the first time a session looks at a ticket that has one. Pi's `write` and
`edit` refuse it, and the sandbox mounts it read-only. The plugin itself writes through a temporary file
and a rename, so a crash leaves the old state or the new, never half of one.

A file that is not valid, or that names an unknown workflow version, is reported and treated as no
workflow, with the path, so you can mend or delete it. `status` says so; nothing is changed.

## Starting, and switching

`workflow start` for a ticket with no state creates the ticket folder if it does not exist (just the folder
and `workflow.json`; `/ticket KEY` fills in the notes, plan and evidence folders), begins the first stage,
and records the hash of the notes, if there are any.

For a ticket that already has a workflow, `start` refuses and says what a switch loses: the stage, the plan
approval, the test results, the scenario results, the reviews and the readings, with their counts. With
`replace: true` it asks you, listing the same, and then:
1. moves the old file to `<ticket folder>/<KEY>/workflow-history/<time>-<name>.json`, so nothing is lost;
2. writes the new state at the first stage.

Starting the same workflow again is also a switch, since it throws the state away.

## Going back

`back` moves to an earlier stage, the previous one unless `to` names another. No condition is checked.
Nothing recorded is erased: the plan approval, test results and reviews are checked against the repository
and the plan as they are, so they still count if nothing changed. The stage's notes hash is taken again,
so `notes-updated` needs a new change. Holds do not depend on the stage.

## Bound repositories

`ticket.json` in the ticket folder lists them (`{ "repositories": ["/path/to/orders-api-PROJ-123"] }`).
`jig-memory` creates the file empty, `jig-review` reads it for ticket scope, and `workflow bind` adds to it.

`bind` asks `jig-git` for a worktree through the `git` tool, so `jig-core` governs it like any call: a
`git worktree add` for `repo`, a new branch named by the workflow's `branch` (default the ticket key), cut
from the fetched base. It then adds the worktree's path. A repository is bound once.

## Two sessions on one ticket

Every change reads the file, changes it and replaces it in one step, so two sessions never leave a torn
file, but the later write wins if both change the same field. Events are recorded by the session that is
running and active on the ticket, so a review approved in a session that does not have the ticket active
is not recorded; approve it again, or approve it where the ticket is active. A hold applies in each
session that has the ticket active.

[Back to the overview](../README.md)
