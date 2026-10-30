# The page

The browser side of `jig-review`. Back to the [jig-review overview](../README.md).

## What it shows

| Page | Address | What it is |
|---|---|---|
| Files changed | `/review/<id>/files` | A file tree and the diffs, split or unified. Hover a line to comment. **Ask** sends one comment now; **Finish review** sends all drafts, and a general comment, together. The review's own repository folder prefixes each path |
| Conversation | `/review/<id>/conversation` | Your comments, the agent's answers (with the small diff it gave), each new round, and the approval, with how it was given |
| Reviews | `/reviews` | Every review record for this workspace, newest first. A review that is not the open one is read-only |
| Settings | `/settings` | The three settings, and the registered passkeys by fingerprint, with Remove and Register |

Approve is in the Finish review dialog. With a passkey registered it goes straight to your device's
prompt. Without one it offers to register a passkey, or to approve in Pi. While Pi is asking, the page
says so, and the header says "approved in page, waiting for you in Pi".

## How it is built

The page is a React and Tailwind app in `web/src/`, built by Vite to static files in `web/dist/`.
It is the reference's page, ported: `react-diff-view` for diffs, `refractor` for highlighting.

- **The build tooling is separate from the plugin.** React, Vite, Tailwind and the rest are the
  `devDependencies` of `web/package.json`, pinned exactly, with their own lockfile. The plugin's runtime
  needs only `hono`, `@hono/node-server` and `ignore`.
- **`web/dist/` is committed,** so installing Jig needs no build.
- **After changing anything under `web/src/`, `web/index.html`, `web/vite.config.ts` or
  `web/package-lock.json`, rebuild and commit `web/dist/` and `web/build.json`:**

  ```sh
  npm --prefix plugins/jig-review/web install    # once
  npm --prefix plugins/jig-review/web run build  # writes web/dist and web/build.json
  npm --prefix plugins/jig-review/web test       # the page's own tests (vitest)
  npm --prefix plugins/jig-review/web run check  # the page's type check
  ```

- `web/build.json` holds the SHA-256 of everything the bundle is built from and of each built file.
  `npm test` at the repository root recomputes both, without the Vite toolchain, and fails with the
  command to run when they disagree. A hand-edited bundle fails the same way.
- Tailwind scans only `web/src/` (`source(".")` in `styles.css`). By default it also reads `dist/`, which
  would make a build depend on the previous build.
- The page and the API are one origin. The page uses relative addresses, so the cookie, Host and
  Origin checks all see the same origin, and `localhost` works for passkeys.

## What the page does not decide

Nothing the page does is trusted. A comment is checked and bounded by the server; an approval is
checked by [the passkey rules](passkeys.md); settings are three booleans and a choice, and anything
else is ignored. The page is shown what the server returns, as text: a diff, a comment or the agent's
summary is never put in the page as markup.
