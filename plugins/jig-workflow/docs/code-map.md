# jig-workflow: code map

Every file of `src/`, what it does and who calls it, and then one real call, `workflow advance`, followed through the
files. Read it with the code open. Back to the [jig-workflow overview](../README.md).

## The files

A test (`plugins/jig-core/test/code-maps.test.ts`) fails when a file of `src/` is missing here or a file listed here is
gone, so this table cannot drift from the code.

### Entry

| File | What it does | Called by |
|---|---|---|
| `index.ts` | The factory: registers the section, the tool, the gate, the command and the listeners for other plugins' events | Pi |

### Tool, command and gate

| File | What it does | Called by |
|---|---|---|
| `tool.ts` | The `workflow` tool: checks the input, classifies each call, builds the questions, runs the action | `index.ts` |
| `commands.ts` | `/workflow`: status, list, start, reload; starting over typed by you counts as your yes | `index.ts` |
| `gate.ts` | The gate registered with `jig-core`: holds on calls, and the calls that always ask | `index.ts`, `tool.ts` |
| `listeners.ts` | Keeps a review approval and a finished CI watch from the event bus as evidence | `index.ts` |

### The actions

| File | What it does | Called by |
|---|---|---|
| `actions.ts` | Puts the action files back under one name | `tool.ts`, `commands.ts` |
| `action-support.ts` | What every action shares: the parameters, the ticket, the started workflow, the stage text | the other `action-` files |
| `action-start.ts` | `list`, `status`, `start` with its replace question, and `bind` | `actions.ts` |
| `action-plan.ts` | `submit-plan` and its question, and `scenario` with its evidence | `actions.ts` |
| `action-tests.ts` | `test`: what would run, the question outside a sandbox, and the run | `actions.ts` |
| `action-stages.ts` | `advance` with its question, and `back` | `actions.ts` |

### Domain logic

| File | What it does | Called by |
|---|---|---|
| `conditions.ts` | The eight exit conditions, each decided from evidence and never from a claim | `action-stages.ts`, `gate.ts`, `runtime.ts` |
| `plan.ts` | `plan.md`: what it must hold, its fingerprint, its numbered scenarios | `action-plan.ts`, `conditions.ts` |
| `tests.ts` | Which command tests a repository, running it, and recording the result against the commit | `action-tests.ts` |
| `status.ts` | Says where the work is: the stage, each missing condition, the holds | `action-start.ts`, `action-support.ts`, `index.ts` |
| `definition.ts` | A workflow file, checked: stages, conditions and holds | `load.ts`, `runtime.ts`, `conditions.ts`, `gate.ts`, `status.ts`, `action-start.ts` |
| `load.ts` | Reads the workflow files from their folders; a bad file is reported and the rest still load | `runtime.ts`, `action-start.ts`, `status.ts` |
| `runtime.ts` | What the plugin keeps while Pi runs: the loaded workflows, the context, the tool results seen | the action files, `gate.ts`, `status.ts`, `commands.ts`, `index.ts` |
| `config.ts` | The `workflow` section of `jig.json`: folders and test commands | `index.ts`, `runtime.ts`, `tests.ts` |

### I/O

| File | What it does | Called by |
|---|---|---|
| `store.ts` | `workflow.json` of a ticket: read, written only by this plugin, and what each piece of evidence is about | the action files, `conditions.ts`, `runtime.ts`, `status.ts`, `tests.ts` |
| `ticket.ts` | The active ticket, its folder, and the repositories bound to it | `action-start.ts`, `conditions.ts`, `gate.ts`, `runtime.ts` |
| `repos.ts` | A repository as the conditions see it: HEAD, branch, clean tree, and which one a call acts in | `conditions.ts`, `gate.ts`, `tests.ts`, `status.ts` |
| `sources.ts` | Evidence from outside: a checked review event, a CI event, a pull request from `gh` | `conditions.ts`, `listeners.ts`, `index.ts` |
| `host.ts` | What the plugin needs from outside: `jig-core`'s programs and sandbox, and the clock | `runtime.ts`, `conditions.ts`, the actions |
| `files.ts` | Replacing a file without ever leaving half of one | `ticket.ts`, `conditions.ts`, `action-support.ts`, `action-start.ts`, `action-plan.ts` |

## How a call flows: `workflow advance`

The agent has finished a stage and asks to move on. The stage's exit conditions are `tests-pass-at-head` and
`you-approve`.

1. **The class.** `jig-core` classifies the call with `classify` in `tool.ts`: a local write, which the rules allow.
2. **The gate.** `jig-core` then asks each gate. The check in `gate.ts` sees a call to the `workflow` tool and runs
   `mustAsk`: the ticket's current stage lists `you-approve`, so the verdict is "ask". `jig-core` builds the question
   with `preview` in `tool.ts`, which calls `advancePreview` in `action-stages.ts`.
3. **Reading the state.** `advancePreview` finds the ticket (`ticketOf`), the started workflow (`started`, which reads
   `workflow.json` through `runtime.ts` and `store.ts`), and the stage and the next one.
4. **Checking the other conditions.** It builds an `Evidence` object with `Runtime.evidence` and asks `evaluateAll` in
   `conditions.ts` about every condition but `you-approve`. Each is decided from a result the plugin made:
   `tests-pass-at-head` compares the recorded test run (`store.ts`) with the repository's HEAD (`repos.ts`). If one is
   missing, `advancePreview` throws an `InputError` and nothing is asked.
5. **The screen.** The preview carries the evidence and a fingerprint of it (`advanceFingerprint`). You answer `y` in
   Pi, inside the waiting call.
6. **The action.** `execute` in `tool.ts` calls `run`, then `actions.advance`. `advance` evaluates the conditions
   again, and compares the fingerprint of what it reads now with the one you approved
   (`rt.host.approvedPreview`). If the evidence changed since you were asked, it throws and moves nothing.
7. **The move.** `advance` evaluates `you-approve` with `approvedNow` set, then `updateState` in `store.ts` writes the
   new stage, the time and a line in the history.
8. **The answer.** `advance` returns "Moved PROJ-123 from build to review" and the new stage's goal, which `tool.ts`
   hands back to the agent.

If a condition is missing in step 6, nothing changes: `advance` returns "Not moved" with each missing condition and
what fixes it.

Back to the [jig-workflow overview](../README.md).
