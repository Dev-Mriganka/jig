# Jig agent guide

Seven plugins are built (`jig-core`, `jig-git`, `jig-memory`, `jig-lens`,
`jig-jira`, `jig-logs`, `jig-api`), `jig-ops` is being built, and the rest are
design. Plugin READMEs are the specifications. Code follows them, and when
either changes, the other changes in the same commit. The tool tables of
`jig-git` and `jig-jira` are read by their tests.

- **Read first:** [docs/architecture.md](docs/architecture.md) and
  [docs/permissions.md](docs/permissions.md).
- **Generic only.** Nothing company-specific goes here: no company names,
  internal system names, environment names or hostnames. Those belong in a
  private company plugin. Examples use `staging`, `orders-api`, `PROJ-123`,
  `api.staging.example.com` and GitHub Actions.
- **README shape.** A plugin README follows
  [plugins/jig-workflow/README.md](plugins/jig-workflow/README.md). Detail that would
  take it past about 120 lines goes to `plugins/<name>/docs/`, linked under
  "More detail".
- **The existing harness is reference only.** Read it to port from; never
  modify it.
- **The floor in [Permissions](docs/permissions.md) is not configurable.** Do
  not add settings that lower it.
- **Approvals happen inside the waiting tool call.** Never add a web endpoint
  that approves.
- **Checks:** `npm run check` (types) and `npm test` must pass before a commit.
- **Git:** clear commit messages, no `Co-Authored-By` lines. Push only when
  asked.
