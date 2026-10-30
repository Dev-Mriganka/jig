# Glossary

| Term | Meaning |
|---|---|
| **Pi** | The coding agent Jig plugs into ([pi.dev](https://pi.dev)). Its extensions are TypeScript. |
| **Plugin** | A Pi package of Jig's, such as `jig-core` or `jig-git`, or a private company plugin. |
| **Company plugin** | A private plugin that adds one employer's environments, sign-in, internal tools and backends. It is never part of this repository. |
| **Overlay skill** | A company's own rules, added to the skill of a generic plugin. The tool stays the same; the agent reads both. |
| **Tool** | Something the model can call: Pi's own `read` or `bash`, or a plugin's `git` or `pr`. |
| **Action** | One operation of a tool with several, such as `git push` or `pr comment`. |
| **Kind** | In a tool table, what an action does: it reads (`read`), writes on this machine (`local write`) or writes to a service outside it (`external write`), and whether it asks you first. |
| **Tool manager** | `jig-core`'s role: it sits over every tool call and applies the rules. |
| **Environment** | Where a call acts: `local`, `external`, `production`, or a company's test environment such as `staging`. |
| **Effect** | Whether a call reads or writes. |
| **Decision** | What the rules say for a call: allow, ask or deny. |
| **The floor** | The rules configuration cannot lower: production writes denied, production results masked, credentials hidden from `bash`, no approval without a screen. |
| **Declaration** | How a Jig tool tells `jig-core` the environment and effect of each of its actions. |
| **Classification** | Working out a call's environment and effect, from the tool's declaration, a configuration rule, Pi's built-in defaults for its own tools, the tool's hints or the default. |
| **Unknown tool** | A tool that nothing classifies. It counts as a write outside the machine, so it asks until a rule or the tool's hints say otherwise. |
| **Approval** | Your answer to an "ask", given inside the waiting call. |
| **Preview** | What a tool shows before a write that asks. If what the write would do changes after you looked, the call is refused and you see the new preview. |
| **Review screen** | A scrollable approval screen for long previews. `o` opens the preview rendered in the browser; `y` approves. |
| **Masking** | Replacing customer personal data in production results with tokens that stay the same all day. Identifiers are never masked. A company plugin can name more fields that hold personal data. |
| **Redaction** | Removing every known secret value from output. |
| **Secret reference** | The name of a stored password or token, such as `pass:work/jira-token`. A tool names it, and `jig-core` resolves it just before the tool runs. The value never reaches the model. |
| **Sign-in service** | Code from a company plugin that signs requests in to one of its systems, such as a single sign-on gateway. A tool asks for the headers of one request by the service's name, and their values are removed from output like secrets. |
| **Transport** | Code from a company plugin that carries a tool's requests to one of its systems, for example through a local sign-in proxy that holds the session, so the tool never sees a token. A tool sends through it by the transport's name. |
| **Section** | A plugin's own part of `jig.json`, such as `git` or `jira`. The plugin checks it, and an error names the key. |
| **Workspace** | The folder Pi started in, or, when Pi started inside a repository, the folder that holds it. `jig-git` finds repositories there. |
| **Spill file** | Where the full result goes when the text shown to the model is cut. The model can open it on demand. |
| **Record** | One line per tool call or model turn, written by `jig-core` and read by `jig-lens`. It never holds tool arguments or output. |
| **Facts** | A few named numbers or short codes that a Jig tool adds to its own record, such as tests passed or a CI run's conclusion. Never free text. |
| **Watch** | A background check on a pull request, a CI run or a tag, started by `ci watch` or by itself after a push. It is saved, so it survives a restart of Pi, and it tells the agent once when its finish line is reached. |
| **Finish line** | The condition that ends a watch, named when it starts, such as a named CI check passing or a pull request being merged. |
| **Artifact ready** | The event `jig-ops` publishes (`jig-ops:artifact-ready`) when a build, tag or release exists for the watched commit. A company plugin decides what follows; `jig-ops` never deploys from it. |
| **Pushed** | The event `jig-git` publishes (`jig-git:pushed`) after a push and after a new pull request. `jig-ops` listens and starts a CI watch for a service of its catalog that has the repository. |
| **Lens index** | `jig-lens`'s SQLite copy of the records, which `/lens` and the optional Grafana dashboards read. It can always be rebuilt from the records. |
| **Sandbox** | Bubblewrap around the agent's own shell and file tools. It hides credentials and keeps the agent's own tooling read-only. Linux only. |
| **Ticket** | A unit of work in an issue tracker, taken through a workflow by `jig-workflow` and remembered by `jig-memory`. |
| **Workflow** | A named, ordered list of stages that you or a company plugin define in a file, such as `feature` or `bugfix`. `jig-workflow` takes a piece of work through one. |
| **Exit condition** | What must hold before work leaves a stage, from a fixed list such as `plan-approved` or `tests-pass-at-head`. |
| **Hold** | A tool call a workflow keeps back until a condition holds, such as `git push` until the tests pass. It only ever tightens a decision. |
| **Ticket folder** | A folder for one ticket, outside every repository: its notes, plan, evidence and the repositories bound to it. |
| **Card** | A short summary of a closed ticket: problem, cause, fix, repositories, identifiers and error text. Planned for `jig-memory`. |
| **Recall** | Finding earlier tickets related to a new one by shared keys, then by keyword search, and handing the agent their cards as a short message. Planned for `jig-memory`. |
| **Memory keeper** | Planned: it writes a ticket's card at close and proposes organizational and personal facts. You approve the exact text of every one. |
| **Evidence** | Tool results saved in the ticket folder while the ticket is active, masked like everything else. |
| **Stage** | A step of a workflow, such as plan or review, with a goal the agent sees and its exit conditions. |
| **Gate** | A condition that holds a stage or an action until it is met, such as an approved plan or a passing test of the exact commit. |
| **Acceptance scenario** | A numbered check in a ticket's plan. It is passed or failed, and a pass needs evidence. |
| **Checker agent** | A read-only agent in a fresh context that reviews a change before you do. Planned. |
| **Review ledger** | Planned: every review comment, from the review page, the pull request or chat, with how it was handled. |
| **Service catalog** | Each service described once for `jig-ops`: its repository, its CI system and where it is, and per environment how it deploys, where it runs and its health address. |
| **Adapter** | A small piece of a plugin that speaks one outside system, such as one CI system or one log backend, behind the plugin's common verbs. An action an adapter does not have is refused, naming it. |
| **Subagent** | A child agent: a full Pi session that another session starts in its own terminal pane. |
| **Agent file** | A file that sets a subagent's role, its tools and its model, such as a planner, a reviewer, a scout or a worker. |
| **Pin** | A hash of a script's folder. A script whose folder changed is refused until you pin it again. |
| **Wiki markup** | Jira's text format. `jig-jira` shows it rendered before it is sent. |
