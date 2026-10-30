# Jig agent guide

Seven plugins are built (`jig-core`, `jig-git`, `jig-memory`, `jig-lens`,
`jig-jira`, `jig-logs`, `jig-api`). `jig-ops` is built: ci, deploy and
runtime. `jig-review` is built: the browser review, approved with a passkey.
The rest are design. Plugin READMEs are the specifications. Code
follows them, and when either changes, the other changes in the same commit.
The tool tables of `jig-git` and `jig-jira` are read by their tests.

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
  that approves, with one exception: `jig-review`'s page approves only with a
  WebAuthn passkey signature the agent cannot make, or marks "approved in page"
  and waits for a `y` in Pi ([Approvals](docs/approvals.md)). Never add a second
  one, and never let that endpoint approve on a secret or a cookie alone.
- **Checks:** `npm run check` (types) and `npm test` must pass before a commit.
- **No secret-shaped literals, even fake ones.** A test value that looks like a
  real credential (a GitHub token, a Postman key, an AWS key, a private-key
  block) is built at run time from parts, such as `["PMAK", "1a2b"].join("-")`.
  Push protection rejects a commit that holds one, and history must then be
  rewritten. `plugins/jig-core/test/no-secret-literals.test.ts` checks this.
- **Git:** clear commit messages, no `Co-Authored-By` lines. Push only when
  asked.
