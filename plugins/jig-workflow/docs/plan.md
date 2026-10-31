# The plan, and its scenarios

What `plan.md` must contain, how you approve it, and how the numbered acceptance scenarios in it are
recorded as passed. Back to the [jig-workflow overview](../README.md).

The plan is the one place where you say, before code is written, what "done" means. It lives in the ticket
folder (`jig-memory` makes `plan.md` there), outside every repository, and the agent writes it with Pi's
file tools. Approval is about its exact text.

## What a plan holds

Three headings, in any order, matched without regard to case:

```markdown
# PROJ-123 plan

## Approach
Cache the price list in OrdersService and invalidate it when a price changes.

## Repositories
- orders-api

## Scenarios
1. A customer reads the price list twice; the second read does not reach the database.
2. A price changes; the next read shows the new price.
```

- **Approach:** at least one line of text.
- **Repositories:** a list of the repositories the change touches, by the name or folder they have in the
  workspace. The check warns, without failing, about a bound repository the plan does not name and a
  name no bound repository has.
- **Scenarios:** a numbered list, `1.` upward with no gaps, at most 50. Each is one scenario, which may
  continue on indented lines. Write what you will see when it works, in the words of the ticket, so that you
  can tell it passed.

A plan that fails the check cannot be submitted, and nobody is asked about it: the call is refused with the
problems, as `jig-core` refuses any call whose input is invalid. A plan over 60,000 characters is too long
to review and is refused.

## Approving it

`workflow submit-plan` is a local write that always asks (the gate sees to it, [Holds](holds.md)).
1. The tool reads `plan.md`, checks it, and builds the preview: the plan rendered as Markdown on
   `jig-core`'s review screen (`o` opens it in the browser), with a line for the scenarios, the
   repositories and the fingerprint.
2. You answer in Pi, inside the waiting call. `y` approves, `n` declines and may say why, which the agent
   reads.
3. The tool compares the fingerprint of the preview you approved with the plan on disk. If the plan changed
   between the question and the answer it refuses with "changed since the preview". Otherwise it saves the
   fingerprint, the time and the number of scenarios.

The fingerprint is a SHA-256 of the plan's text with line endings made alike. `plan-approved` holds
while `plan.md` still has that fingerprint, so any edit, by the agent or by you, brings the holds back and
asks for another approval. Approving a plan does not approve the code.

## Scenarios

`scenarios-pass` reads the numbered scenarios from the plan on disk, which must be the approved one.
`workflow scenario` records one result: `number`, `result` (`pass` or `fail`) and, for a pass, **evidence**:

| Evidence | What it is | What the plugin checks |
|---|---|---|
| `path` | A file in the ticket folder, such as `evidence/accept-1.png` or a saved tool result | It exists, is a file of more than 0 bytes, and is inside the folder once links are followed |
| `toolResult` | The id of a tool call from this session | The plugin saw that call's result in this session, and it was not an error |
| `text` | What was observed, 10 to 2000 characters | It is there; `status` shows it as text, the weakest kind |

- **A result belongs to the scenario's text.** It is saved with a hash of that scenario, so editing the
  scenario, which also needs a new approval, makes its old pass stop counting.
- **A fail is recorded too,** without evidence, and holds `scenarios-pass` back until a pass replaces it.
- **The pass is the agent's claim,** made with evidence you can open. The plugin cannot judge that a
  screenshot shows the right thing; the evidence is there for you, and `you-approve` on the stage is where
  you look.
- **A scenario number that is not in the plan** is refused.

[Back to the overview](../README.md)
