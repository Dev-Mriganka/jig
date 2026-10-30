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
| test environments | A company's shared test systems, such as staging or QA | added by a company plugin |

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
3. **The tool's hints,** which Pi and MCP tools can carry. `readOnlyHint` means
   a read; `destructiveHint` or `openWorldHint` means a write.
4. **The default:** an unknown tool counts as a write to `external`, so it asks
   until you classify it.

Pi's own tools have defaults built in:

| Tool | Environment | Effect | Default decision |
|---|---|---|---|
| `read`, `ls`, `find`, `grep` | local | read | allow |
| `write`, `edit` | local | write | allow |
| `bash` | local, inside the sandbox | write | allow (the sandbox is the protection, see Architecture) |
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
- ask before `bash` commands that match a pattern.

## The floor: what configuration cannot change

| Fixed rule | Why |
|---|---|
| Writes to `production` are denied | One wrong setting must not allow production writes |
| `production` results are always masked | Masking is how customer data stays out of the model's context and the session files |
| With no screen to ask on (headless runs, child agents without a dialog), "ask" becomes "deny" | Nobody can approve, so nothing that needs approval runs |
| An unknown tool cannot be allowed by default; it needs a rule naming it | A new package must not get unchecked writes |
| Credentials stay hidden from `bash` | That is the sandbox's job, and configuration does not reach into it |

Configuration can always add strictness. For example, it can mask a test
environment too, make every write ask, or deny a tool outright.

## Configuration file

Personal settings live in `~/.pi/agent/jig.json`. A company plugin adds its
environments and classification rules at start-up, and the field names its data
uses for personal data. The schema is defined in `plugins/jig-core/README.md`.
The example below is illustrative:

```json
{
  "environments": {
    "staging": { "kind": "test" },
    "qa":      { "kind": "test" },
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
