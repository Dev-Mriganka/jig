# Reuse: existing packages before our own

**Status: research in progress.** This page lists the existing Pi packages and
tools judged against Jig's needs, with a verdict for each: use as is, use and
extend, borrow the pattern, or skip.

## Decided

| Need | Choice | Verdict |
|---|---|---|
| Observability viewer | Grafana OSS with the `frser-sqlite-datasource` plugin; Datasette as the fallback | use as is. See [`jig-lens`](../plugins/jig-lens/README.md) |

## Being evaluated

| Need | Candidates |
|---|---|
| Tool manager (rules over every tool, approvals) | `@gotgenes/pi-permission-system`, and others from the Pi package store |
| Question and approval forms | `@juicesharp/rpiv-ask-user-question` (in use today), and better-looking alternatives |
| Git and GitHub tools | GitHub and git packages from the Pi package store |
| Secret backends | `pass`, macOS Keychain, 1Password CLI; any Pi packages that wrap them |

*Results, with download counts, licences and verdicts, will be added here.*
