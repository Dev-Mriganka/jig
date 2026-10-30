# Jig

Jig is a set of plugins for the [Pi](https://pi.dev) coding agent. They decide
what the agent may do, ask you when it matters, keep secrets out of its reach,
and record what happened so you can see it later.

**Status:** `jig-core` is built; the other plugins are still design. Each
plugin's README is the specification that its code follows.

## Where Jig sits

![Jig is the harness you own, around Pi, which is the harness its builders made around the model; a dashed outer ring is a later team harness](docs/img/harnesses.svg)

*Three harnesses, one inside the other, in [Birgitta Böckeler's](https://martinfowler.com/articles/harness-engineering.html) terms: the model is what gets harnessed, Pi's builders made the inner harness, and Jig is yours. A team harness would be the next ring if a team adopts Jig, and shared organizational memory would live there.*

## How Jig steers the agent

![Guides feed forward into Pi before it acts, sensors feed back after it acts, and you steer by changing both](docs/img/harness-at-a-glance.svg)

*Guides go forward into Pi before it acts, sensors feed back after it acts, and you steer by changing both. A star marks a model deciding, a dot a program, a figure a person, and a dashed outline something planned for later.*

## The plugins

| Plugin | What it does |
|---|---|
| [`jig-core`](plugins/jig-core/README.md) | The tool manager. It governs every tool the agent can call: Pi's own (`read`, `write`, `edit`, `bash`), Jig's, and other packages'. It handles rules per environment, approvals, secrets, masking and records |
| [`jig-git`](plugins/jig-git/README.md) | Local git, GitHub pull requests and reviews, CI checks, watching CI until it finishes, and tags and releases |
| [`jig-lens`](plugins/jig-lens/README.md) | Observability: cost, tool success and failure, and time spent waiting for you, in a local dashboard |
| [`jig-flow`](plugins/jig-flow/README.md) | The ticket flow: stages, gates, test runs, acceptance scenarios |
| [`jig-memory`](plugins/jig-memory/README.md) | Ticket folders, notes and evidence; later, recall of related tickets |
| [`jig-mongo`](plugins/jig-mongo/README.md) | MongoDB reads, with production limited to approved fields |
| [`jig-jira`](plugins/jig-jira/README.md) | Jira issues: reads, comments, transitions, updates, with rendered previews |
| [`jig-logs`](plugins/jig-logs/README.md) | Log search over a backend such as Elasticsearch |
| [`jig-http`](plugins/jig-http/README.md) | Calls to named APIs, with sign-in added by the tool |
| [`jig-k8s`](plugins/jig-k8s/README.md) | Kubernetes reads: pods, rollout status, logs |
| [`jig-scripts`](plugins/jig-scripts/README.md) | Your own scripts as tools, pinned by hash |
| [`jig-review`](plugins/jig-review/README.md) | Code review in the browser |
| [`jig-agents`](plugins/jig-agents/README.md) | Subagents in terminal panes |

Every plugin needs `jig-core`; otherwise they work on their own.

![Layers from Pi at the bottom, through jig-core, the generic plugins and other packages' tools, to your private company plugin on top](docs/img/what-lives-where.svg)

*What lives where. Everything below the company plugin goes with you to any job; the company plugin stays private and only configures the generic plugins or adds backends and knowledge to them.*

**Company parts never go into this repository.** These are a company's
environment names, sign-in service, internal tools and backends. They live in
a private company plugin, so these generic plugins can go with you to any job.
[Plugins](docs/plugins.md) shows, for every tool, what is generic and what the
company plugin supplies, and the order of building.

## Read in this order

1. [Architecture](docs/architecture.md): how the tool manager sits over every
   tool, what it can and cannot control, and where each plugin fits.
2. [Permissions](docs/permissions.md): environments, rules per tool, and the
   floor that configuration cannot lower.
3. [Approvals](docs/approvals.md): how and where you are asked.
4. [Secrets](docs/secrets.md): where passwords and tokens come from, on any
   operating system.
5. [Plugins](docs/plugins.md): every tool and the plugin it belongs to.
6. [Decisions](docs/decisions.md): what was decided, what was rejected, and why.
7. [Glossary](docs/glossary.md): the terms these documents use.

## Relationship to the existing harness

Jig is built clean, beside the harness the author uses every day today:
- **It does not modify that harness.**
- **It ports what works.**
- **That harness keeps running** until each Jig plugin can replace its part.
