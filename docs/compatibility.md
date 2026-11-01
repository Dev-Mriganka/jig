# Compatibility

What Jig is tested with, what a company plugin or a configuration file may rely on, and what counts as a breaking change. A name that is
public here is pinned by a test, so it cannot change by accident.

## Tested with

| Pi | Node | Checked |
|---|---|---|
| 1.4.0 | 24, 26 | 2026-11-01 |

- **Every push and pull request** runs the `Checks` job on both Node lines with exactly this Pi, installed in `.github/workflows/ci.yml`.
- **Every week** the [Pi canary](../.github/workflows/pi-canary.yml) runs `npm run check`, `npm test` and `npm run check:install` on the
  newest Pi that npm has, on Node 26. It never runs on a pull request. A red canary means the next Pi would break Jig.
- **Not tested:** other Pi versions, and Node 22.19, the lowest that `package.json` allows. `peerDependencies` say `*` because Pi
  supplies its own packages to an extension, so the real requirement is this table.
- **To move the Pi version,** follow "Pi version" in [AGENTS.md](../AGENTS.md): the pin, this table and the README change together.

## What is public

Company plugins import `jig-core`'s contract and kit, and people write `jig.json` and dashboards against the names below. They are
Jig's public interface. Each row is pinned by a test in `plugins/jig-core/test/`, whose expectations are literals written in the test.

| Public | Pinned by |
|---|---|
| The global handle, `version` and every member of `JigApi` | `surface.test.ts` |
| Every name the contract, the client and the kit export | `surface.test.ts` |
| The fields of a record line | `surface.test.ts` |
| The `JIG_*` environment variables | `surface.test.ts` |
| Every tool name and its actions, every slash command, every `jig.json` section | `plugin-surface.test.ts` |
| Which parts of `jig-core` a plugin may import | `boundaries.test.ts` |

- **The handle** is `Symbol.for("jig.core.api/v1")` on `globalThis`, which holds the `JigApi`. Plugins that load before `jig-core` wait
  on `Symbol.for("jig.core.pending/v1")`. `JigApi.version` is `1`.
- **The contract** is `plugins/jig-core/src/contract.ts`: the types, `JIG_EVENTS` and `JigApi`. Plugins reach the API through `jig()` and
  `withJig()` of `plugins/jig-core/src/client.ts`. See [the plugin contract](../plugins/jig-core/docs/plugin-contract.md).
- **The kit** is the stateless helpers in `plugins/jig-core/src/kit/`. Every name they export is public.
- **Tools and actions** are what the model is told it can call, what a person's rules in `jig.json` name, and what a company plugin's
  classify rules match. A name is a promise.
- **The record line** is one JSON object per call or turn in `<state>/records/`, which `jig-lens` and dashboards read
  ([Records](../plugins/jig-core/docs/records.md)).
- **The variables** are `JIG_STATE_DIR`, `JIG_CONDITION`, `JIG_AGENT_ROLE`, `JIG_PARENT_SESSION`, `JIG_ROLE_POLICY`, `JIG_LENS_INDEX`,
  `JIG_LENS_DASHBOARDS` and `JIG_THEME_FOOTER`.
- **Everything else in `jig-core`** is internal: any other file, the text of a message, the layout of `/jig`. It can change in any
  commit. A plugin never imports it, and `boundaries.test.ts` fails when one does.

## What counts as breaking

- **Breaking:** removing or renaming a public name; refusing input a caller may send today; requiring a new field; changing the
  meaning or unit of a field; removing a record field; raising the Pi or Node version Jig needs.
- **Not breaking:** adding a member, export, tool, action, record field, section or variable; accepting more input; changing the
  wording of a message or a preview; anything internal.

## How to change it

- **Adding is fine.** Add the name to the test that pins it, and to the docs, in the same commit.
- **Removing or renaming needs a reason on record.** Write a dated entry in [Decisions](decisions.md) first: what goes, why, and what a
  company plugin does instead. Change the pin in the same commit as the code.
- **A break in the contract needs a new version.** Raise `JigApi.version`. The two handle symbols end in `/v1`, so a plugin built for an
  older contract finds no `jig-core` and fails closed, rather than running against an API that changed under it.
- **A pin is never loosened to get green.** When a pin test fails, either the change was a slip and is undone, or it is on purpose and
  the decision comes first. Deleting a literal, or swapping an exact comparison for a looser one, is not a fix.

Back to the [README](../README.md).
