# Holds

How a workflow holds a tool call, through a gate in `jig-core` that can only make a decision stricter.
Back to the [jig-workflow overview](../README.md).

A hold is "not this call until that condition holds". The plugin does not stop calls itself and no tool
reads its files: it registers a **gate** with `jig-core`, which asks it about each call after the rules
have decided ([What asks](../../jig-core/docs/approval-screens.md)).

## The gate in `jig-core`

`jig().gates.register(gate)` takes a `name`, the `plugin`, and `check(call, signal)`. The call it sees has
the tool, the action, the environment and its kind, the effect, the decision so far (`allow` or `ask`),
the call's input, Pi's working folder, and for Pi's `write` and `edit` the absolute paths they act on
(as written, and with links followed). The gate may answer:

| Answer | Effect |
|---|---|
| nothing | The decision stands |
| `{ decision: "ask", reason }` | An `allow` becomes an `ask`; an `ask` stays one |
| `{ decision: "deny", reason }` | The call is blocked with the reason |

- **It cannot loosen.** There is no way to answer `allow`: that, or any other shape, counts as no answer,
  and `/jig` reports the gate. A decision the floor made (a production write, a protected path, no screen
  to ask on) is final before gates run, and an `ask` with no screen still becomes a `deny` afterwards.
- **A failure blocks the call.** A gate that throws, or takes more than 10 seconds, denies the call with
  "jig-core could not decide", as every failure in `jig-core` does.
- **Several gates:** the strictest answer wins, and a `deny` ends the asking.
- **It is recorded** as the decision's source `gate`, with the gate's name on the event, so `/lens` shows
  how often a hold stopped work. The reason goes to the model and is not written to the records.

[Plugin contract](../../jig-core/docs/plugin-contract.md#gates) has the exact types.

## What a hold matches

`calls` holds tool names and actions. `"git push"` is the `git` tool with the action `push`; `"write"` is
Pi's `write`. A name alone matches every action of the tool.

| Tool | Held when |
|---|---|
| `write`, `edit` | a path the call writes is inside a bound repository |
| `git`, `pr` | the call's `repo` (or, without one, the repository Pi runs in) is a bound repository |
| any other | always, in the work the session has active |

- **Which repository `git` and `pr` mean** is worked out as `jig-git` does: an absolute path inside a work
  tree, or a folder name in the workspace (the folder Pi started in, or the folder that holds the
  repository it started in). A call whose repository cannot be worked out is not held; the tool then fails
  on it by itself.
- **A path counts as inside** after links are followed, so a link from elsewhere into a bound repository
  does not escape a hold, and `../` is folded away.
- **A per-repository condition** (`tests-pass-at-head`, `review-done`, `pull-request-open`,
  `checks-pass`) is checked for that repository alone, so a push of one is not held by another's tests.
- **The reason** names the workflow, the ticket, the call, the condition, what is missing and the action that
  fixes it: `held by workflow feature on PROJ-123: git push waits for tests-pass-at-head, which is not met:
  orders-api: no test run at 1a2b3c4: run workflow test`.
- **A hold is in force from the start,** whatever the stage, and ends when its condition holds. If the
  condition stops holding (an edited plan, a new commit), the hold is back. `status` lists them.

## Calls that always ask

For these the gate answers `ask` even when a rule or an earlier "allow for this session" would allow, so
that your answer is a fresh one ([Approvals](../../../docs/approvals.md)):

| Call | Why it asks |
|---|---|
| `workflow submit-plan` | You approve this exact plan, with its fingerprint |
| `workflow advance`, from a stage that lists `you-approve` | You decide to move on, with the evidence in view |
| `workflow start` with `replace`, over a workflow that has state | Starting over loses evidence, and the question says which |
| `workflow test` when `jig-sandbox` cannot run it | The commands run as you, outside the sandbox ([Tests](tests.md)) |

"Allow for this session" on these allows that one call: the gate asks again next time. With no screen
(a headless run, a child agent without a dialog) an `ask` is a `deny`, so none of these happens unseen.

## What a hold does not cover

- **`bash`.** A sandboxed shell can change a file, which is why the sandbox tells the agent to change code
  with `edit` and `write`. Put `"bash"` in `calls` to hold every shell command; it is held everywhere,
  not only in bound repositories, so use it with care.
- **Another session on the same ticket,** and a child agent (`jig-agents`): the gate follows the active
  ticket of the session it runs in. A child that has no active ticket is not held.
- **A repository that is not bound.** Binding is what puts a repository in scope ([State](state.md)).
- **Before `session_start`,** when the plugin has not yet learned the active ticket.

## How the gate finds the ticket

`jig-memory` keeps the active ticket in a session entry (`jig-memory-ticket`). The plugin reads the latest
one from the session each time the gate asks. It then reads `workflow.json`, a small file, and goes on to
`ticket.json` and git only for a call that one of the holds could match.

[Back to the overview](../README.md)
