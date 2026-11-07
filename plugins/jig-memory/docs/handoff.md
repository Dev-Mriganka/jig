# Handoff: pasted evidence and open checks

What the `ticket` tool keeps for the active ticket: the output of runs the user did
themselves, and the checks the agent promised before the next step. Back to the
[jig-memory overview](../README.md).

In a long piece of work the user often runs the risky steps and pastes the output
back. Without a record, that output is gone at the next compaction, and a check the
agent promised in one message is easy to skip in the same message. The tool writes
both down in the ticket folder.

## The tool

| Action | Takes | What it does |
|---|---|---|
| `save_evidence` | `text`, `label` | Saves pasted text to `evidence/`, masked, with an index line |
| `add_check` | `text` | Adds an open check of up to 200 characters |
| `list_checks` | nothing | The open checks, and how many are closed |
| `close_check` | `id`, `outcome` | Closes a check, with what was found or done, up to 200 characters |
| `recall` | `query` | Searches earlier tickets' cards and notes by text; read only, active ticket excluded, history warning |

- **Every action is local.** `list_checks` and `recall` read; the others write the ticket
  folder, which the rules allow by default ([Permissions](../../../docs/permissions.md)).
- **Each needs an active ticket,** and says how to set one when there is none.
- **Nothing is blocked.** The open checks are shown and the agent is asked to close
  or name them; holding a call until a check is closed is a workflow's job.

## Pasted evidence

`save_evidence` takes the text as the user pasted it and a label of 1 to 40
letters, digits, spaces, `-` or `_`, such as `batch 3 output`.
- **Masked like a production result.** The tool masks it through `jig-core`, since
  pasted output may hold customer data, whatever system it came from.
- **Secrets removed like any result.** The masked text is the tool's result, so
  `jig-core` removes known secrets and secret shapes from it. This plugin saves it
  after that, and the model gets the file's name back instead of the text.
- **The file** is `evidence/<time>-pasted-<label>-<random>.txt`, and the index line
  is `- <time> | pasted | <label> | <file>`.
- **At most 48 KB.** Longer text is refused, not cut: save it in parts.

A result that `jig-core` withheld (it could not be checked) is not saved.

## Open checks

An open check is something the agent said it would do before the next step, such
as `re-derive the locations before the next batch`.
- **With every prompt** of yours while a check is open, the agent gets the list as
  a message, and the message ends with the rule: close each check, or say plainly
  that it is still open, before handing over the command for the next step.
- **In the notes message** after activation and after a compaction, below the notes.
- **In the reminder** that comes after 15 results, as a count.
- **`/ticket`** shows how many are open.

At most 20 checks can be open at once. The numbers count up and are never reused.

## The checks file

`checks.json` in the ticket folder, private to you (mode `0600`), made when the first
check is added. Other programs, such as a status panel, can read it. It is replaced
whole and synced, so a reader never sees half of it.

```json
{
  "version": 1,
  "checks": [
    {
      "id": 1,
      "text": "re-derive the locations before the next batch",
      "status": "closed",
      "openedAt": "2026-11-02T19:20:00.000Z",
      "closedAt": "2026-11-02T19:41:00.000Z",
      "outcome": "done: 12 locations re-derived, 1 changed"
    },
    { "id": 2, "text": "confirm the batch 4 ids with the user", "status": "open", "openedAt": "2026-11-02T19:42:00.000Z" }
  ]
}
```

- **`status`** is `open` or `closed`; a closed check keeps its `closedAt` and
  `outcome`.
- **Times** are ISO times in UTC.
- **A file that is not of this shape** is reported and never overwritten: fix or
  remove it.

Back to the [jig-memory overview](../README.md).
