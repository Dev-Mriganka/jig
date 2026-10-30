# Plugins: every tool, and where it goes

This is the map of every tool the agent uses and the plugin it belongs to.
Generic plugins live in this repository and go with you to any job. Company
parts live in a private company plugin kept at the company.

![Layers from Pi at the bottom, through jig-core, the generic plugins and other packages' tools, to your private company plugin on top](img/what-lives-where.svg)

*What lives where. Everything below the company plugin goes with you to any job; the company plugin stays private and only configures the generic plugins or adds backends and knowledge to them.*

## Tools that need no plugin

| Tool | Where it comes from | How Jig handles it |
|---|---|---|
| `read`, `ls`, `find`, `grep` | Pi | `jig-core` default: local read, allowed |
| `write`, `edit` | Pi | `jig-core` default: local write, allowed |
| `bash` | Pi | runs in the sandbox; `jig-core` default: allowed, with optional command rules |
| `ask_user_question` | `@juicesharp/rpiv-ask-user-question` | allowed by default, so a question never asks first. `@adeildo/pi-ask-questions` is the nicer-looking alternative, and Jig's forms build on it |
| tools from any other package | that package | `jig-core` classifies them from the tool's hints or your rules; unknown tools ask |

## Generic plugins (this repository)

| Plugin | Status | Tools and actions | What the company plugin supplies | Order |
|---|---|---|---|---|
| [`jig-core`](../plugins/jig-core/README.md) | built | `watch`: list, stop; the tool manager, the watch engine and the `/jig` commands | environments, classification rules, extra personal-data field names for masking, sign-in services and transports | 1 |
| [`jig-git`](../plugins/jig-git/README.md) | built | `git`: status, diff, log, show, blame, branches, fetch, clone, branch, worktree, commit, stash, sync, merge, rebase, cherry_pick, restore, push · `pr`: view, list, comments, create, edit, ready, comment, reply, resolve, review, merge · `checks`: status, runs, run, artifacts, log, rerun, watch · `release`: tags, releases, tag_create, tag_push, release_create | the GitHub organization, branch names, protected branches, the pull request template, the "artifact ready" rules | 2 |
| [`jig-lens`](../plugins/jig-lens/README.md) | built | none: the `/lens` command, over `jig-core`'s records | none | 2 |
| [`jig-workflow`](../plugins/jig-workflow/README.md) | design | `workflow`: list, status, start, bind, submit-plan, test, scenario, advance; holds through `jig-core` | its workflow files, the ticket key patterns they match, acceptance environments | 3 |
| [`jig-memory`](../plugins/jig-memory/README.md) | built | no tools: ticket folders, notes and evidence, and the `/ticket` command; later cards and recall | ticket key patterns, folder location | 3 |
| [`jig-mongo`](../plugins/jig-mongo/README.md) | design | `mongo`: describe, count, find, distinct, aggregate | connection routes (for example through a bastion host or a VPN), approved collections and fields | 4 |
| [`jig-jira`](../plugins/jig-jira/README.md) | built | `jira`: get, search, comments, transitions, changelog, attachments, assignable, find_field · create, comment, edit_comment, delete_comment, transition, update | the Jira site and its sign-in | 5 |
| [`jig-logs`](../plugins/jig-logs/README.md) | built | `logs`: search by phrase or query, time window, filters, paging | the log backend: address, indexes, environment names, sign-in | 6 |
| [`jig-http`](../plugins/jig-http/README.md) | built | `http`: a method, path, body and headers to a named target | the named targets and their sign-in | 7 |
| [`jig-ops`](../plugins/jig-ops/README.md) | design | `ci`: status, runs, log, rerun, trigger, watch · `deploy`: plan, run, status, rollback, watch · `runtime`: pods, rollout, logs, events, health | the service catalog, its CI systems and deploy methods, transports | 7 |
| [`jig-review`](../plugins/jig-review/README.md) | design | `start_interactive_code_review`, `record_interactive_review_resolution` | none | 8 |
| [`jig-agents`](../plugins/jig-agents/README.md) | design | `subagent`, `subagent_message`, `subagent_status`, `subagent_interrupt`, `subagent_done`, `caller_ping` | which model each role uses | 8, unless a store package replaces it |

`jig-ops` is being built, starting with its Kubernetes runtime adapter.

## How company parts plug in

![The same generic jira tool set up by two companies, each with its own site, sign-in, ticket key pattern and overlay skill](img/company-plugs-in.svg)

*The difference between companies is configuration and knowledge, not code: each company plugin supplies its own site, sign-in, ticket key pattern and an overlay skill, which is its own rules added to the plugin's skill. The `jira` tool stays the same.*

## What stays in the company plugin

Some tools exist only because of one employer, and never come into this
repository:
- internal databases and billing systems;
- a company deploy tool and its pipelines (for example, one that deploys a
  built image to `staging` after CI passes);
- the model provider account and budget;
- the sign-in service;
- scripts that need credentials or production access, as company tools.
  Everyone else runs scripts with `bash`, in the sandbox.

Another CI system (GitLab CI, Jenkins, Buildkite) is generic. If it is needed at
more than one job, its tools move into a generic plugin then, not before.

## Order, and why

1. **`jig-core`:** everything else needs it.
2. **`jig-git` and `jig-lens`:** git is the first real tool, and the records
   show from the first day what it costs and how often it fails.
3. **`jig-workflow` with `jig-memory`:** workflows carry the fixes that
   matter most:
   - trustworthy checks;
   - one approval per change;
   - review before anything is shared.
4. **The data and service tools,** one at a time, each with its company part.
5. **Review and subagents,** unless a package from the Pi store does the job
   better (see [Reuse](reuse.md)).
