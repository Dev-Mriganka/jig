# Plugins: every tool, and where it goes

This is the map of every tool the agent uses and the plugin it belongs to.
Generic plugins live in this repository and go with you to any job. Company
parts live in a private company plugin kept at the company.

## Tools that need no plugin

| Tool | Where it comes from | How Jig handles it |
|---|---|---|
| `read`, `ls`, `find`, `grep` | Pi | `jig-core` default: local read, allowed |
| `write`, `edit` | Pi | `jig-core` default: local write, allowed |
| `bash` | Pi | runs in the sandbox; `jig-core` default: allowed, with optional command rules |
| `ask_user_question` | `@juicesharp/rpiv-ask-user-question` | allowed by default, so a question never asks first. `@adeildo/pi-ask-questions` is the nicer-looking alternative, and Jig's forms build on it |
| tools from any other package | that package | `jig-core` classifies them from the tool's hints or your rules; unknown tools ask |

## Generic plugins (this repository)

| Plugin | Tools and actions | What the company plugin supplies | Order |
|---|---|---|---|
| [`jig-core`](../plugins/jig-core/README.md) | `watch`: list, stop; the tool manager, the watch engine and the `/jig` commands | environments, extra masking kinds, the sign-in service | 1 |
| [`jig-git`](../plugins/jig-git/README.md) | `git`: status, diff, log, show, blame, branches, fetch, clone, branch, worktree, commit, stash, sync, merge, rebase, cherry_pick, restore, push · `pr`: view, list, comments, create, edit, ready, comment, reply, resolve, review, merge · `checks`: status, runs, run, artifacts, log, rerun, watch · `release`: tags, releases, tag_create, tag_push, release_create | the GitHub organization, branch names, protected branches, the pull request template, the "artifact ready" rules | 2 |
| [`jig-lens`](../plugins/jig-lens/README.md) | none: the dashboard over `jig-core`'s records | none | 2 |
| [`jig-flow`](../plugins/jig-flow/README.md) | `flow`: status, start, bind, submit-plan, test, scenario, advance, and the gates | ticket kinds, stage sets, acceptance environments | 3 |
| [`jig-memory`](../plugins/jig-memory/README.md) | no tools today: ticket folders, notes, evidence; later cards and recall | ticket key patterns, folder location | 3 |
| [`jig-mongo`](../plugins/jig-mongo/README.md) | `mongo`: describe, count, find, distinct, aggregate | connection routes, jump hosts, approved collections and fields | 4 |
| [`jig-jira`](../plugins/jig-jira/README.md) | `jira`: get, search, comments, transitions, changelog, attachments, assignable, find_field · create, comment, edit_comment, delete_comment, transition, update | the Jira site and its sign-in | 5 |
| [`jig-logs`](../plugins/jig-logs/README.md) | `logs`: search by phrase or query, time window, filters, paging | the log backend: address, indexes, environment names, sign-in | 6 |
| [`jig-http`](../plugins/jig-http/README.md) | `http`: a method, path, body and headers to a named target | the named targets and their sign-in | 7 |
| [`jig-k8s`](../plugins/jig-k8s/README.md) | `k8s`: pods, status, logs, api | the services table | 7 |
| [`jig-scripts`](../plugins/jig-scripts/README.md) | `script`: list, run | the scripts themselves | 7 |
| [`jig-review`](../plugins/jig-review/README.md) | `start_interactive_code_review`, `record_interactive_review_resolution` | none | 8 |
| [`jig-agents`](../plugins/jig-agents/README.md) | `subagent`, `subagent_message`, `subagent_status`, `subagent_interrupt`, `subagent_done`, `caller_ping` | which model each role uses | 8, unless a store package replaces it |

## What stays in the company plugin

Some tools exist only because of one employer, and never come into this
repository:
- internal databases and billing systems;
- the deploy repository and its pipelines;
- the model provider account and budget;
- the sign-in service.

CI products such as Concourse or Jenkins are generic. If they are needed at
more than one job, their tools move into a generic plugin then, not before.

## Order, and why

1. **`jig-core`:** everything else needs it.
2. **`jig-git` and `jig-lens`:** git is the first real tool, and the records
   show from the first day what it costs and how often it fails.
3. **`jig-flow` with `jig-memory`:** the ticket flow carries the fixes that
   matter most:
   - trustworthy checks;
   - one approval per change;
   - review before anything is shared.
4. **The data and service tools,** one at a time, each with its company part.
5. **Review and subagents,** unless a package from the Pi store does the job
   better (see [Reuse](reuse.md)).
