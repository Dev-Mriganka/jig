# Jig agent guide

Fourteen of the fourteen plugins are built: `jig-core`, `jig-git`, `jig-memory`,
`jig-lens`, `jig-jira`, `jig-logs`, `jig-api`, `jig-ops`, `jig-review`,
`jig-mongo`, `jig-theme`, `jig-sandbox`, `jig-workflow` and `jig-agents`.
`examples/jig-acme` is an example company plugin for a fictional company: the one
place a company plugin lives in this repository, and its tests run with `npm test`.

Plugin READMEs are the specifications. Code follows them, and when either
changes, the other changes in the same commit. Tests read the tool tables of
`jig-git`, `jig-jira` and `jig-mongo`, and the READMEs and docs of `jig-lens`,
`jig-theme`, `jig-workflow` and `jig-agents`, so change a table and its test together.

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
- **Code maps.** `jig-core`, `jig-api`, `jig-ops`, `jig-sandbox`, `jig-agents` and `jig-workflow` each have
  `docs/code-map.md`: every file of `src/` with what it does and who calls it, and one call followed through
  the files. When you add, rename or remove a file in one of them, change its map in the same commit; a test
  fails when they disagree. A source file over 500 lines is reported as a warning: split it by job.
- **Docs.** Write them by [Writing the docs](docs/writing.md): open with what
  it is and why, short paragraphs and table cells (about 350 and 100
  characters), lists with bold lead-ins, generic examples, tagged code blocks.
  A test fails on a broken link or anchor.
- **The existing harness is reference only.** Read it to port from; never
  modify it.
- **The floor in [Permissions](docs/permissions.md) is not configurable.** Do
  not add settings that lower it.
- **No sign-in and no stored credentials in any plugin.** No OAuth or
  device-code flow, no browser login, no password prompt, no token written to a
  file. The tool that owns a login does it (`gh`, the Postman CLI, Pi's
  `/mcp login`, a company plugin's sign-in service). A plugin gets a credential
  from a source the user configured, through `jig-core`, which attaches it to
  the request so the plugin never sees the value. See
  [Decisions](docs/decisions.md).
- **Approvals happen inside the waiting tool call.** Never add a web endpoint
  that approves, with one exception: `jig-review`'s page approves only with a
  WebAuthn passkey signature the agent cannot make, or marks "approved in page"
  and waits for a `y` in Pi ([Approvals](docs/approvals.md)). Never add a second
  one, and never let that endpoint approve on a secret or a cookie alone.
- **`jig-sandbox` tests run the real sandbox.** They need `bwrap`, `socat`, `rg` and
  `python3` as programs (`sudo apt install bubblewrap socat ripgrep python3`; on Ubuntu 24.04 also
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`), skip with the reason
  when those are missing, and fail in CI (`CI` is set), where they are installed.
  `JIG_SANDBOX_TEST_BWRAP`, `_SOCAT` and `_RG` name the first three when they are elsewhere. A test
  uses a fake home built at run time, hides the real home's credential paths as well,
  and never reads a file under it or contacts any host but a server of its own.
- **`jig-agents` tests start a real Pi.** `test/real-pi.test.ts` runs the Pi installed next to Node
  (`npm install -g @earendil-works/pi-coding-agent@1.4.0`; `JIG_AGENTS_TEST_PI` names another) as a child,
  with this repository's `jig-core` and `jig-agents` and Pi's own scripted model, so it calls no model. It skips
  with the reason when there is no Pi 1.x, and runs in CI, where Pi is installed. It uses a temporary agent
  folder and home, never `~/.pi/agent`, and never the `pi` on `PATH`, which may be a wrapper that signs in. Two tests also
  load `jig-sandbox` for a read-only `bash`, and skip with the reason when the sandbox's programs are missing.
- **Checks:** `npm run check` (types, Biome, and the two dependency checks below), `npm test`, `npm run check:install`
  and the review page's checks (`npm run check:web`, `npm run test:web`, `npm run check:dist`) must
  pass before a commit; CI runs all of them on every push and pull request, and `ci-ok` is the one job to require.
  Run `npm run format` before committing. The page's checks need `npm ci` in
  `plugins/jig-review/web` first, and a change under its `src/` needs a rebuild
  (`npm run build` there) or `check:dist` fails. `check:install` needs network: it lets the stock Pi install a copy of this
  working tree as `pi install git:` does, and every extension must load.
- **Integration tests** run the plugins against real services: `npm run test:it`, and the `integration` job in CI. A
  suite skips when its service's address is not set, so `npm test` and `npm run check` never need a service. See
  [Integration tests](docs/integration-tests.md). Every test file starts in an isolated environment (temporary home, a git
  identity, no credentials): [what a test can rely on](docs/integration-tests.md#what-a-test-can-rely-on).
- **The public surface is pinned.** `jig-core`'s contract, client and kit, every tool and action name, slash command and
  `jig.json` section, the record fields and the `JIG_*` variables are literals in `plugins/jig-core/test/surface.test.ts` and
  `plugin-surface.test.ts`, and a plugin may import only `jig-core`'s `contract.ts`, `client.ts` and `kit/`
  (`boundaries.test.ts`). Adding is fine: add the name to the test. Removing or renaming needs a [Decisions](docs/decisions.md)
  entry first, and a contract break a new `version`. Never loosen a pin to get green. See [Compatibility](docs/compatibility.md).
- **Pi version.** The Pi that Jig is tested with is named in four places that move together: both `Install Pi` steps of
  `.github/workflows/ci.yml`, the "Tested with" tables in `README.md` and `docs/compatibility.md` (with the date), and the install
  command in the `jig-agents` bullet above. To move it: run the weekly Pi canary by hand (`.github/workflows/pi-canary.yml`,
  "Run workflow") and wait for it to be green on the new release, change those places in one commit, and run `npm run check`,
  `npm test` and `npm run check:install` on that Pi. `plugins/jig-core/test/ci-config.test.ts` fails when they disagree.
- **No secret-shaped literals, even fake ones.** A test value that looks like a
  real credential (a GitHub token, a Postman key, an AWS key, a private-key
  block) is built at run time from parts, such as `["PMAK", "1a2b"].join("-")`.
  Push protection rejects a commit that holds one, and history must then be
  rewritten. `plugins/jig-core/test/no-secret-literals.test.ts` checks this.
- **Dependencies:** every npm dependency, in the root and in `plugins/jig-review/web`, is on its latest stable
  release (no pre-release) and pinned to an exact version, with no `^` or `~`. Dependabot
  (`.github/dependabot.yml`) opens a weekly PR for patch and minor updates together and one PR per major, and waits
  3 days (7 for a major) after a release before proposing it. `@anthropic-ai/sandbox-runtime` is `0.0.x` and
  security-critical: its update is its own change, with the real-sandbox tests run and the version noted in
  `plugins/jig-sandbox/docs/design.md`. TypeScript is the native 7.x compiler: it has no programmatic API, so no
  code here may `import "typescript"`. Pi's packages stay peer dependencies (`*`). `.npmrc` makes `npm install` write exact
  versions and skip releases younger than 2 days; CI uses `npm ci --ignore-scripts`. `npm run check` fails on a version that
  is not exact (`scripts/check-pinned-deps.mjs`) and on an import in a plugin that is not a root `dependency`, a Node module or
  a Pi package, because `pi install git:` installs `dependencies` only (`scripts/check-runtime-deps.mjs`).
- **Git:** clear commit messages, no `Co-Authored-By` lines. Push only when
  asked.
