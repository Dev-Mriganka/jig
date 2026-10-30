# Jig

Jig is a set of plugins for the [Pi](https://pi.dev) coding agent. They decide
what the agent may do, ask you when it matters, keep secrets out of its reach,
and record what happened so you can see it later.

**Status:** five of the thirteen plugins are built. Each plugin's README is the
specification that its code follows.

## What works today

`jig-core` governs every tool call, with rules per environment, approvals,
secret references, masking of production results and background watches.
`jig-git` gives the agent git, GitHub pull requests, CI checks and releases, and
watches CI until it finishes. `jig-memory` keeps a folder of notes and evidence
for each ticket. `jig-lens` shows cost, tool failures and the time spent waiting
for you. `jig-jira` reads and changes Jira issues, with rendered previews.
`jig-logs` searches OpenSearch or Elasticsearch logs, and `jig-http` calls named
APIs with sign-in added by the tool. `jig-k8s` is being built. The other
plugins are designs.

## Where Jig sits

![Jig is the harness you own, around Pi, which is the harness its builders made around the model; a dashed outer ring is a later team harness](docs/img/harnesses.svg)

*Three harnesses, one inside the other, in [Birgitta Böckeler's](https://martinfowler.com/articles/harness-engineering.html) terms: the model is what gets harnessed, Pi's builders made the inner harness, and Jig is yours. A team harness would be the next ring if a team adopts Jig, and shared organizational memory would live there.*

## How Jig steers the agent

![Guides feed forward into Pi before it acts, sensors feed back after it acts, and you steer by changing both](docs/img/harness-at-a-glance.svg)

*Guides go forward into Pi before it acts, sensors feed back after it acts, and you steer by changing both. A star marks a model deciding, a dot a program, a figure a person, and a dashed outline something planned for later.*

## The plugins

| Plugin | Status | What it gives you |
|---|---|---|
| [`jig-core`](plugins/jig-core/README.md) | built | The tool manager. It governs every tool the agent can call: Pi's own (`read`, `write`, `edit`, `bash`), Jig's, and other packages'. Rules per environment, approvals, secrets, sign-in, masking, background watches and records |
| [`jig-git`](plugins/jig-git/README.md) | built | Local git, GitHub pull requests and reviews, CI checks, watching CI until it finishes, and tags and releases |
| [`jig-lens`](plugins/jig-lens/README.md) | built | A summary inside Pi of cost, tool failures, time spent waiting for you, blocked calls and checks; Grafana optional |
| [`jig-flow`](plugins/jig-flow/README.md) | design | The ticket flow: stages, gates, test runs, acceptance scenarios |
| [`jig-memory`](plugins/jig-memory/README.md) | built | Ticket folders, notes and evidence; later, recall of related tickets |
| [`jig-mongo`](plugins/jig-mongo/README.md) | design | MongoDB reads, with production limited to approved fields |
| [`jig-jira`](plugins/jig-jira/README.md) | built | Jira issues: reads, comments, transitions, updates, with rendered previews |
| [`jig-logs`](plugins/jig-logs/README.md) | built | Log search over a backend such as Elasticsearch |
| [`jig-http`](plugins/jig-http/README.md) | built | Calls to named APIs, with sign-in added by the tool |
| [`jig-k8s`](plugins/jig-k8s/README.md) | design | Kubernetes reads: pods, rollout status, logs |
| [`jig-scripts`](plugins/jig-scripts/README.md) | design | Your own scripts as tools, pinned by hash |
| [`jig-review`](plugins/jig-review/README.md) | design | Code review in the browser |
| [`jig-agents`](plugins/jig-agents/README.md) | design | Subagents in terminal panes |

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
