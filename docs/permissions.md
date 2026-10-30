# Permissions

`jig-core` decides every tool call from three things:
- **where the call acts:** its *environment*;
- **what it does:** its *effect*, a read or a write;
- **your rules.**

Configuration can make anything stricter. It can never lower the floor.

## Environments

| Environment | Meaning | Built in? |
|---|---|---|
| `local` | This machine: files, the local git repository, local processes | yes |
| `external` | Services outside the machine that are not one of your environments: GitHub, Jira, Slack | yes |
| `production` | Live systems with real customer data | yes. A company profile says which of its targets count as production |
| test environments | A company's test systems, such as `staging` or `dev` | added by a company plugin |

A tool call names its target in its own terms (for example `env: "prod"`), and
a classification rule maps that to one of these environments.

## How a call gets its environment and effect

These sources are checked in order, and the first answer wins:

1. **The tool's own declaration.** Jig tools say what each action does. For
   example, `git push` is a write to `external`, and `mongo find` with
   `env: "prod"` is a read in `production`.
2. **A classification rule in your configuration,** for tools Jig did not
   write. For example: tool `other_db`, parameter `target`, value `live`, means
   `production`.
3. **Pi's own tools,** which have defaults built in (the table below). A
   classification rule comes first, so a rule on `bash` can reclassify a
   command.
4. **The tool's hints,** which Pi and MCP tools can carry. `readOnlyHint` means
   a read; `destructiveHint` or `openWorldHint` means a write.
5. **The default:** an unknown tool counts as a write to `external`, so it asks
   until you classify it.

Pi's own tools:

| Tool | Environment | Effect | Default decision |
|---|---|---|---|
| `read`, `ls`, `find`, `grep` | local | read | allow, except a protected path (see the floor) |
| `write`, `edit` | local | write | allow, except a protected path (see the floor) |
| `bash` | local, inside the sandbox | write | allow (the sandbox is the protection, see Architecture) |
| `bash` with `outside: true` | local, outside the sandbox: action `outside` | write | **ask**; only a rule naming it allows it (see the floor) |
| `powershell` | local | write | allow |
| question tools: `ask_user_question`, `ask_questions` | local | read | allow, so a question never asks first |

## The rules table

The defaults:

| Effect | local | external | test environment | production |
|---|---|---|---|---|
| read | allow | allow | allow | allow, **always masked** |
| write | allow | ask | ask | **deny, fixed** |

You can change any cell, or set rules for a single tool or action. For
example:
- ask before `git push`;
- allow writes to a test environment without asking;
- ask before `bash` commands that match a pattern (`command` in a rule);
- allow one command to run outside the sandbox without asking, by naming it:
  `{ "tool": "bash", "action": "outside", "command": "docker compose *",
  "decision": "allow" }`.

## The floor: what configuration cannot change

| Fixed rule | Why |
|---|---|
| Writes to `production` are denied | One wrong setting must not allow production writes |
| `production` results are always masked | Masking is how customer data stays out of the model's context and the session files |
| With no screen to ask on (headless runs, child agents without a dialog), "ask" becomes "deny" | Nobody can approve, so nothing that needs approval runs |
| An unknown tool cannot be allowed by default; it needs a rule naming it | A new package must not get unchecked writes |
| Credentials stay hidden from `bash` | That is the sandbox's job, and configuration does not reach into it. `/jig` says whether `bash` is sandboxed, and with no sandbox it says plainly that it is not |
| `bash` run outside its sandbox asks | Only a rule naming the tool `bash`, the action `outside` and a command pattern allows it without asking; no wildcard and no default does. With no screen it is refused |
| Pi's file tools refuse **protected paths** (see below) | A credential the agent can read leaks a login, and a folder it can write could load code or loosen a rule |

Configuration can always add strictness. For example, it can mask a test
environment too, make every write ask, deny a tool outright, or protect more
paths.

### Protected paths

- **The defaults.**
  - *Secret* (neither read nor written), in Pi's agent folder: `auth.json` and
    `mcp-auth.json`.
  - *Secret*, in the home folder: `.ssh`, `.gnupg`, `.password-store`, `.aws`,
    `.kube`, `.azure`, `.config/gcloud`, `.config/gh`, `.config/glab-cli`,
    `.postman`, `.docker/config.json`, `.netrc`, `.git-credentials`, `.npmrc`
    and `.pypirc`.
  - *Secret*, where `gh`, `glab` and `gcloud` keep their files when they are not
    in the home folder: inside `$XDG_CONFIG_HOME` when it is set, and on Windows
    inside `%APPDATA%`.
  - *Guarded* (readable, not writable): the whole agent folder (`~/.pi/agent`,
    or where `PI_CODING_AGENT_DIR` points).
- **How a path is matched.** `~` is expanded, a relative path starts from Pi's
  working folder, `..` is folded away, and symlinks are followed (also a link
  that points nowhere yet), so a link in a project that points into `~/.ssh` is
  caught. A path equal to a protected path, or inside one, matches. On Windows
  and macOS case is ignored.
- **Per tool.**
  - `read` and `grep` are refused inside a secret path.
  - `grep` is also refused when the folder it searches *contains* one:
    searching `~` would read `~/.ssh`, so it says to search a narrower folder.
  - `find` and `ls` show names only, so they are refused only inside a secret
    path.
  - `write` and `edit` are refused inside a secret or a guarded path.
- **Only additions.** Your `jig.json` (`protectedPaths`) and company plugins
  (`config.addProtectedPaths`) can add paths. Nothing removes a default.
- **Where it stops.** It covers Pi's file tools. `bash` is the sandbox's job
  (`jig-sandbox` hides the same list from it): without a sandbox, a shell command
  can still reach these paths, and `/jig` and session start say so.

## Configuration file

Personal settings live in `~/.pi/agent/jig.json`. A company plugin adds its
environments and classification rules at start-up, and the field names its data
uses for personal data.

The fields are in the [jig-core README](../plugins/jig-core/README.md#configure),
and how rules match is in its
[configuration reference](../plugins/jig-core/docs/configuration.md). The
example below is illustrative:

```json
{
  "environments": {
    "staging": { "kind": "test" },
    "dev":     { "kind": "test" },
    "prod":    { "kind": "production" }
  },
  "rules": [
    { "tool": "git", "action": "push", "decision": "ask" },
    { "tool": "deploy", "environment": "staging", "decision": "allow" }
  ],
  "classify": [
    { "tool": "other_db", "param": "target", "value": "live", "environment": "prod", "effect": "read" }
  ]
}
```

## What `/jig rules` shows

One line per tool, with its environment, effect, effective decision and the
source of each, including tools Jig did not write. A tool still on the unknown
default is flagged, so you can classify it.
