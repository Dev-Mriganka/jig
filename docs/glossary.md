# Glossary

| Term | Meaning |
|---|---|
| **Pi** | The coding agent Jig plugs into ([pi.dev](https://pi.dev)). Its extensions are TypeScript. |
| **Plugin** | A Pi package of Jig's, such as `jig-core` or `jig-git`, or a private company plugin. |
| **Company plugin** | A private plugin that adds one employer's environments, sign-in, internal tools and backends. It is never part of this repository. |
| **Tool** | Something the model can call: Pi's own `read` or `bash`, or a plugin's `git` or `pr`. |
| **Action** | One operation of a tool with several, such as `git push` or `pr comment`. |
| **Tool manager** | `jig-core`'s role: it sits over every tool call and applies the rules. |
| **Environment** | Where a call acts: `local`, `external`, `production`, or a company's test environment such as staging. |
| **Effect** | Whether a call reads or writes. |
| **Decision** | What the rules say for a call: allow, ask or deny. |
| **The floor** | The rules configuration cannot lower: production writes denied, production results masked, credentials hidden from `bash`, no approval without a screen. |
| **Classification** | Working out a call's environment and effect, from the tool's declaration, a configuration rule, the tool's hints or the default. |
| **Approval** | Your answer to an "ask", given inside the waiting call. |
| **Review screen** | A scrollable approval screen for long previews. `o` opens the preview rendered in the browser; `y` approves. |
| **Masking** | Replacing customer personal data in production results with tokens that stay the same all day. Identifiers are never masked. |
| **Redaction** | Removing every known secret value from output. |
| **Spill file** | Where the full result goes when the text shown to the model is cut. The model can open it on demand. |
| **Record** | One line per tool call or model turn, written by `jig-core` and read by `jig-lens`. It never holds tool arguments or output. |
| **Sandbox** | Bubblewrap around the agent's own shell and file tools. It hides credentials and keeps the agent's own tooling read-only. Linux only. |
| **Ticket** | A unit of work in an issue tracker, followed by `jig-flow` and remembered by `jig-memory`. |
