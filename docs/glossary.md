# Glossary

The words these documents use, in groups. Each plugin README links a term the
first time it uses it, where that helps.

## Pi and plugins

| Term | Meaning |
|---|---|
| **Pi** | The coding agent Jig plugs into ([pi.dev](https://pi.dev)). Its extensions are TypeScript. |
| **Plugin** | A Pi package of Jig's, such as `jig-core` or `jig-git`, or a private company plugin. |
| **Company plugin** | A private plugin with one employer's environments, sign-in, tools and backends. See [Writing a company plugin](company-plugin.md). |
| **Overlay skill** | A company's own rules, added to a generic plugin's skill. The tool stays the same. |
| **Tool** | Something the model can call: Pi's own `read` or `bash`, or a plugin's `git` or `pr`. |
| **Action** | One operation of a tool with several, such as `git push` or `pr comment`. |
| **Kind** | In a tool table: `read`, `local write` (this machine) or `external write` (a service). |
| **Section** | A plugin's own part of `jig.json`, such as `git` or `jira`. An error names the key. |
| **Workspace** | The folder Pi started in, or the repository folder that holds it. |
| **Adapter** | A small piece of a plugin that speaks one outside system, such as one CI system or one log backend. |

- **A company plugin** is never part of this repository. The one exception is [`examples/jig-acme`](../examples/jig-acme/README.md),
  a made-up company's plugin that shows how to write one.
- **Kind** also says whether the action asks you first, such as `external write, asks`.
- **A section** is checked by its plugin, which starts with defaults when it is wrong.
- **A workspace** is where `jig-git` finds repositories.
- **An adapter** that lacks an action refuses it, naming it.

## Rules and decisions

| Term | Meaning |
|---|---|
| **Tool manager** | `jig-core`'s role: it sits over every tool call and applies the rules. |
| **Environment** | Where a call acts: `local`, `external`, `production`, or a test environment such as `staging`. |
| **Effect** | Whether a call reads or writes. |
| **Decision** | What the rules say for a call: allow, ask or deny. |
| **The floor** | The rules configuration cannot lower, such as production writes being denied. |
| **Declaration** | How a Jig tool tells `jig-core` the environment and effect of each of its actions. |
| **Classification** | Working out a call's environment and effect, from the declaration, a rule, a default or a hint. |
| **Unknown tool** | A tool that nothing classifies. It counts as a write outside the machine, so it asks. |
| **Protected path** | A path Pi's file tools refuse: *secret* (no read, no write) or *guarded* (read only). |

- **The floor** is: production writes denied, production results masked,
  credentials hidden from `bash`, no approval without a screen, and protected
  paths refused. See [Permissions](permissions.md#the-floor-what-configuration-cannot-change).
- **Classification** takes its answer from the tool's declaration, then a rule
  in your configuration, Pi's built-in defaults, the tool's hints, and last
  the default. See
  [Permissions](permissions.md#how-a-call-gets-its-environment-and-effect).
- **A protected path** is a credential file, or Pi's agent folder, where
  `jig.json` lives. Configuration can add paths and never remove one.
- **An unknown tool** asks until a rule or the tool's own hints say otherwise.

## Approvals

| Term | Meaning |
|---|---|
| **Approval** | Your answer to an "ask", given inside the waiting call. |
| **Preview** | What a tool shows before a write that asks. A call is refused if the write changed since. |
| **Review screen** | A scrollable approval screen for long previews. `y` approves, `o` opens the browser. |

See [Approvals](approvals.md). When a write changed since you looked, the call
is refused and you see the new preview.

## Secrets and data

| Term | Meaning |
|---|---|
| **Masking** | Replacing customer personal data in production results with tokens that stay the same all day. |
| **Redaction** | Removing every known secret value from output. |
| **Secret reference** | The name of a stored secret, such as `pass:work/jira-token`. The model never sees the value. |
| **Sign-in service** | Company plugin code that signs requests in to one of its systems. |
| **Transport** | Company plugin code that carries a tool's requests to one of its systems. |
| **Signed-in request** | A request `jig-core` sends for a plugin, adding the credential, so the plugin never sees it. |
| **Spill file** | Where the full result goes when the text shown to the model is cut. |
| **Sandbox** | The operating-system box `jig-sandbox` runs the agent's `bash` in (bubblewrap on Linux and WSL2, Seatbelt on macOS). It hides credentials and keeps the agent from planting what runs later outside. |
| **Broker** | The small process, one per session, in which the sandbox runtime runs, so its placeholder files and signal handlers stay out of Pi and the project. |
| **Background task** | A command the agent starts with `background: true`: it runs in the sandbox, wakes the agent when it ends or prints what it asked for, and ends with the session. `/ps` lists them. |
| **Localhost bridge** | What carries a background task's server, and the ports you list in `network.localhost`, into each command in the `filtered` and `ask` network modes, where every command has a network of its own. |
| **Locked path** | A path the sandbox lets `bash` read and never write, because something outside the sandbox runs it later: `~/.bashrc`, `PATH` folders, git hooks, Pi's settings. |
| **Ask-first path** | A toolchain folder such as `~/.sdkman` that `bash` can write once you say yes, for the session or always. |

- **Masking** never touches identifiers. A company plugin can name more fields
  that hold personal data (see [Masking](../plugins/jig-core/docs/masking.md)).
- **A secret reference** is resolved by `jig-core` just before the tool runs
  (see [Secrets](secrets.md)).
- **A sign-in service** is asked for the headers of one request, as a single
  sign-on gateway would give them. Their values are removed from output like
  secrets.
- **A transport** can go through a local sign-in proxy that holds the session,
  so the tool never sees a token. A tool sends through it by name.
- **A spill file** holds the full result, which the model can open on demand.

## Records and watches

| Term | Meaning |
|---|---|
| **Record** | One line per tool call or model turn, written by `jig-core` and read by `jig-lens`. |
| **Facts** | A few named numbers or short codes a Jig tool adds to its record. Never free text. |
| **Watch** | A background check on a pull request, a CI run or a tag. It is saved, so it survives a restart. |
| **Finish line** | The condition that ends a watch, named when it starts, such as a named CI check passing. |
| **Artifact ready** | The event `jig-ops:artifact-ready`: a build, tag or release exists for the watched commit. |
| **Pushed** | The event `jig-git:pushed`, after a push and after a new pull request. |
| **Lens index** | `jig-lens`'s SQLite copy of the records. It can always be rebuilt. |

- **A record** never holds tool arguments or output.
- **Facts** are, for example, tests passed or a CI run's conclusion.
- **A watch** is started by `ci watch`, or by itself after a push, and tells
  the agent once when its finish line is reached (see
  [Watches](../plugins/jig-core/docs/watches.md)).
- **Artifact ready** is for a company plugin to act on. `jig-ops` never
  deploys from it.
- **Pushed** makes `jig-ops` start a CI watch for a service of its catalog
  that has the repository.

## Tickets and workflows

| Term | Meaning |
|---|---|
| **Ticket** | A unit of work in an issue tracker, such as `PROJ-123`. |
| **Ticket folder** | A folder for one ticket, outside every repository: notes, plan, evidence and bound repositories. |
| **Evidence** | Tool results saved in the ticket folder while the ticket is active, masked like everything else. In a workflow, the result of a test run, a plan approval, a review or a scenario, saved against the commit or plan it is about. |
| **Bound repository** | A repository listed in a ticket's `ticket.json`: a workflow's holds, tests and reviews apply there. |
| **Workflow state** | `workflow.json` in the ticket folder: the stage and each result with the commit or plan it is about. Only `jig-workflow` writes it. |
| **Workflow** | A named, ordered list of stages that you or a company plugin define in a file. |
| **Stage** | A step of a workflow, such as plan or review, with a goal the agent sees. |
| **Exit condition** | What must hold before work leaves a stage, from a fixed list such as `plan-approved`. |
| **Hold** | A tool call a workflow keeps back until a condition holds. It only ever tightens a decision. |
| **Gate** | A check a plugin registers with `jig-core`. It sees each call after the rules and can only make the decision stricter. `jig-workflow` holds calls with one. |
| **Acceptance scenario** | A numbered check in a ticket's plan. A pass needs evidence. |
| **Checker agent** | A read-only agent in a fresh context that reviews a change before you do. Planned. |
| **Card** | A short summary of a closed ticket: problem, cause, fix, repositories, identifiers and error lines. |
| **Recall** | Finding earlier tickets related to a new one, and handing the agent their cards. |
| **Recall test** | Invented cards and queries that measure how many right cards recall returns, and how many wrong ones. |
| **Memory keeper** | Planned: writes a ticket's card at close and proposes facts. You approve every one. |

- **A ticket** is taken through a workflow by `jig-workflow` and remembered by
  `jig-memory`.
- **A workflow** is, for example, `feature` or `bugfix`.
- **A hold** is, for example, `git push` until the tests pass.
- **A gate** is, for example, the check that denies `git push` until the tests passed at the exact commit.
- **Recall** works by shared keys first, then keyword search.

## Code review

| Term | Meaning |
|---|---|
| **Passkey** | A key pair your device makes (Windows Hello, Touch ID, a security key) to prove you are present. |
| **Fingerprint** | The SHA-256 of a passkey's public key, so you can tell which key is which. |
| **Review round** | One pass of a review: your comments, the agent's answers, and the new diff. |
| **Approved** | `jig-review`'s `jig-review:approved` event, with how it was approved: `passkey` or `page-and-pi`. |
| **Review ledger** | Planned: every review comment, from any source, with how it was handled. |

- **A passkey** is stored as its public half, and the agent cannot make the
  signature (see [Approvals](approvals.md)).
- **A fingerprint** is shown by Pi when you register a key, and on the
  settings page.
- **A review ledger** would take comments from the review page, the pull
  request or chat.

## Systems

| Term | Meaning |
|---|---|
| **Service catalog** | Each service described once for `jig-ops`: its repository, its CI, and how it deploys and runs. |
| **Collection** | A team's saved API requests in one place, such as a Postman export or a folder of `.http` files. |
| **Saved request** | One request in a collection. The agent runs it by name and fills only its variables. |
| **Pinned host** | A host an environment's requests may reach. Any other host is refused. |
| **Allow list** | In `jig-mongo`: only what is listed may be seen. Production uses one. |
| **Deny list** | In `jig-mongo`: what is listed may not be seen. Test environments use one. |
| **Wiki markup** | Jira's text format. `jig-jira` shows it rendered before it is sent. |

- **A service catalog** also says, per environment, where it runs and its
  health address.
- **A collection** comes with its environments, and `jig-api` reads it.
- **A pinned host** is one that an environment's own addresses come to.
- **Allow and deny lists** reach fields, not only databases and collections.

## Subagents

| Term | Meaning |
|---|---|
| **Subagent** | A child agent: a separate Pi process, in RPC mode, with the same plugins as the session that starts it, so Jig's rules govern it. |
| **Agent file** | A file that sets a role: its description, tools, the actions of a tool, whether it writes, the skills it reads, and its prompt. Its model comes from configuration. |
| **Role** | What a subagent is for: `scout` explores, `reviewer` reviews, `worker` changes code in a worktree of its own. A role is an agent file, and `/agents roles` lists them. |
| **Narrowing** | What a role does to its child: it can take away tools, actions and writing, and never add them. The child enforces it with a gate, from a policy in its environment. |

## The look

| Term | Meaning |
|---|---|
| **Palette** | The look of a theme as seventeen named colours, such as `text`, `accent` and `error`. |
| **Footer part** | One piece of the one-line footer, such as `model`, `context` or `cost`. |

- **A palette** is turned into all of Pi's roles by one role map. `jig-theme`
  ships six, and you write your own in `jig.json`.
- **A footer part** is chosen by you, with its order. Another plugin adds its
  own by emitting `jig-theme:segment`.
