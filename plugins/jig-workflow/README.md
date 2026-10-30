# jig-workflow: named workflows, with stages and gates

**Status: design.**

`jig-workflow` takes a piece of work, such as a ticket, through a
**workflow**: a named, ordered list of stages. Each stage has a goal and the
conditions that let the work move on.

You write the workflows, and the plugin has none built in. For example:
- `feature`: understand → plan → build → review → deliver → accept → done;
- `bugfix`: reproduce → fix → verify → done;
- `investigation`: gather → explain → done.

Start one by name, `/workflow start feature PROJ-123`, or let a workflow claim
a ticket by its key.

![What the harness regulates around a ticket: maintainability, compatibility, behaviour and data safety, each with guides and sensors](../../docs/img/what-it-regulates.svg)

*What the harness regulates around a ticket, in [Böckeler's](https://martinfowler.com/articles/harness-engineering.html) layout. Behaviour stays highlighted because it is the hardest to sense: acceptance scenarios in the plan, the tests, and you in an acceptance environment together cover it.*

## Define a workflow

One JSON file per workflow, named after it: `~/.pi/agent/workflows/feature.json`.
A project's `.pi/workflows/` folder is read too, once you trust the project.

```json
{
  "name": "feature",
  "description": "A change to a service, from plan to acceptance on staging",
  "match": { "ticket": "^PROJ-\\d+$" },
  "stages": [
    { "id": "understand", "goal": "Read the ticket and the code, and write notes", "exit": ["notes-updated"] },
    { "id": "plan", "goal": "Write plan.md with numbered acceptance scenarios", "exit": ["plan-approved"] },
    { "id": "build", "goal": "Change the code and test it", "exit": ["tests-pass-at-head"] },
    { "id": "review", "goal": "Review the change before anyone else sees it", "exit": ["review-done"] },
    { "id": "deliver", "goal": "Open the pull request and deploy to staging", "exit": ["pull-request-open", "checks-pass"] },
    { "id": "accept", "goal": "Run the acceptance scenarios on staging", "exit": ["scenarios-pass"] },
    { "id": "done" }
  ],
  "holds": [
    { "until": "plan-approved", "calls": ["git commit", "git push", "write", "edit"] },
    { "until": "tests-pass-at-head", "calls": ["git push"] }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | The handle you start it by: letters, digits and `-` |
| `description` | One line, shown by `/workflow list` |
| `match` | Optional. A ticket-key pattern, so `start` can leave the name out |
| `stages` | In order: an `id`, a `goal` the agent sees, and `exit` conditions |
| `holds` | Calls held until a condition holds, each with a reason that names it |

- **`match`:** when exactly one workflow matches a ticket, `start` can leave the name out.
- **`exit`:** every condition must hold before the work advances.
- **`holds`:** a held call is denied, with a reason that names the condition. `write` and `edit` are held only inside the work's
  bound repositories.

## Conditions

A workflow is built from this fixed list. The plugin checks each one itself,
so a workflow file never runs code:

| Condition | Holds when |
|---|---|
| `notes-updated` | The ticket's notes changed since the stage began (see `jig-memory`) |
| `plan-approved` | You approved `plan.md`; an edited plan needs approving again |
| `tests-pass-at-head` | Each bound repository's tests passed at its exact HEAD |
| `review-done` | A review of the change is recorded |
| `pull-request-open` | Each bound repository has an open pull request for the work's branch |
| `checks-pass` | The pull requests' required checks passed, as a `jig-git` watch reported |
| `scenarios-pass` | Every numbered scenario in the plan passed, each with its evidence |
| `you-approve` | You approve moving on, in a dialog |

## Tool: `workflow`

| Action | Kind | What it does |
|---|---|---|
| `list` | read | The workflows defined, with their stages |
| `status` | read | The work's workflow and stage, what each exit condition still needs, and the holds in force |
| `start` | local write | Starts a workflow by name for a ticket, and creates the ticket folder (see `jig-memory`) |
| `bind` | local write | Creates a worktree for a repository on the work's branch |
| `submit-plan` | local write | Checks `plan.md` and asks you to approve it |
| `test` | local write | Runs a bound repository's tests at HEAD, and records the result for that commit |
| `scenario` | local write | Records pass or fail for one scenario. A pass needs evidence |
| `advance` | local write | Moves to the next stage when every exit condition holds, or lists what is missing |

- **`status`** without a ticket gives every active piece of work.
- **`bind`** cuts the worktree's branch from the latest main branch.
- **`submit-plan`** checks the approach, the repositories and the numbered scenarios.

## Commands

| Command | What it does |
|---|---|
| `/workflow` | The status of this session's work |
| `/workflow list` | The workflows defined, and every file that failed to load, with the reason |
| `/workflow start <name> [ticket]` | Starts a workflow |
| `/workflow reload` | Reads the workflow files again |

## Rules

- **Nothing is built in.** Workflows are read from their files at session
  start and on `/workflow reload`. Adding one needs no code.
- **One workflow per piece of work.** Starting another workflow on the same
  ticket is an explicit `start` that says what the switch loses.
- **Holds go through `jig-core`.** This plugin registers a gate with
  `jig-core`. A gate can only make a decision stricter, never looser, and the
  floor still applies. Tools never read this plugin's files.
- **No code in a workflow file.** Conditions come from the list above. A
  custom check belongs in a repository's test command, which
  `tests-pass-at-head` runs.
- **One writer per worktree.** Two Pi sessions never write to the same
  worktree at once.
- **A broken file is reported, not guessed.** A workflow file with an unknown
  field, condition or stage is skipped, and `/workflow list` names the file and
  the key.

## Company part (in the company plugin)

- its workflow files, such as one per kind of ticket;
- the ticket key patterns its workflows `match`;
- which test environments count as acceptance environments.

## Later, from the design reviews

![A ticket over time: guides feed forward into Pi, and feedback comes back at four points: the edit loop, the checker loop, your one approval, and after the pull request](../../docs/img/ticket-loops.svg)

*A ticket over time. Guides go into Pi before it writes code, and feedback comes back at four points: the edit loop, the checker, your one approval, and after the pull request, where CI, reviews and teammates report through the review ledger.*

- **Check tiers:** compile, affected tests, diff rules and a full run, each
  failure compared with the main branch by full test name. A failure that
  already exists there never blocks a stage.
- **A checker agent** that reviews the change before anything is shared.
- **A review-comment ledger:** every comment from the review page, the pull
  request or chat, with how it was handled.
- **One approval per change:** pushes need only passing tests, and you approve
  once with all the evidence before the pull request is shared.

![How the full run decides: no test report fails, new tests that did not run fail, and only failures that are new compared with the main branch block](../../docs/img/check-full.svg)

*How the full run decides. Each question answers a failure seen in real sessions, named in red on the right; a failure that already exists on the main branch never blocks a stage.*

## Layout (planned)

```text
jig-workflow/
  src/      workflow files (load, check), stages, conditions, the gate jig-core asks, plan check, test runner, state
  skills/   workflow/SKILL.md: how to take work through its workflow
  test/
```
