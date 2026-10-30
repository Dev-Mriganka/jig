# jig-flow: the ticket flow

**Status: design.**

`jig-flow` carries a ticket from first look to done in stages, with gates that
hold until their conditions are met. A company plugin defines the stage sets.
For example:
- a feature ticket: understand → plan → build → review → deliver → acceptance
  → done;
- a support ticket: investigate → resolve → done.

![What the harness regulates around a ticket: maintainability, compatibility, behaviour and data safety, each with guides and sensors](../../docs/img/what-it-regulates.svg)

*What the harness regulates around a ticket, in [Böckeler's](https://martinfowler.com/articles/harness-engineering.html) layout. Behaviour stays highlighted because it is the hardest to sense: acceptance scenarios in the plan, the tests, and you in an acceptance environment together cover it.*

## Tool: `flow`

| Action | Kind | What it does |
|---|---|---|
| `status` | read | The stage, the plan's state, what the next move still needs, each bound repository's HEAD with its test result, and the acceptance scenarios. Without a ticket: every active flow |
| `start` | local write | Begins the flow at the first stage, and creates the ticket folder (see `jig-memory`) |
| `bind` | local write | Creates a worktree for a repository on the ticket's branch, cut from the latest main branch |
| `submit-plan` | local write | Checks `plan.md` (approach, repositories, numbered acceptance scenarios) and asks you to approve it. The approval is bound to the plan's hash |
| `test` | local write | Runs the repository's tests at HEAD and records pass or fail for that exact commit |
| `scenario` | local write | Records pass or fail for one acceptance scenario, naming its evidence. A pass needs evidence |
| `advance` | local write | Moves to the next stage when its conditions hold; otherwise lists what is missing |

## Gates

- **Plan before code.** In a ticket's repository, branch creation, commits and
  pushes wait for your approval of the plan.
- **Tests before push.** A push needs a passing test of the exact commit being
  pushed.
- **One writer per worktree.** Two Pi sessions never write to the same
  worktree at once.
- **Review before deliver.** The change is reviewed before it leaves the build
  stages.

`git` and other tools reach the gates through `jig-core`. The gate decision
lives here, and tools never read this plugin's files.

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

## Company part (in the company plugin)

- ticket kinds and their key patterns;
- the stage sets;
- which test environments count as acceptance environments.

## Layout (planned)

```text
jig-flow/
  src/      stages, gates, plan check, test runner, state (hidden from the agent)
  skills/   ticket-flow/SKILL.md: how to work a ticket through the stages
  test/
```
