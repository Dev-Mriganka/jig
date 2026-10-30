# Configuration reference

The fields of `jig.json` are in the [jig-core overview](../README.md#configure).
This page holds what goes with them: how rules and classification rules match,
secret references, the sections other plugins keep in the same file, and the
environment variables.

## Rules

- **The first rule that matches decides.** List them most specific first. Your
  own rules come before the ones a company plugin adds, so yours win.
- **`tool` may use `*`** for any run of characters, as in `mcp__db__*`.
  `action`, `environment` and `effect` match exactly. A field you leave out
  matches anything.
- **A rule that would lower the floor is refused,** with the file and the key
  named, and the rest of the file still loads. That means a rule that names a
  production environment and allows or asks for a write there. A rule with no
  `effect` counts as covering writes, so give a production rule `effect:
  "read"`. An environment name nobody defined counts as production.
- **A wildcard rule cannot allow a tool that nothing classified.** Name the
  tool exactly, or classify it.
- **"Allow for this session" is remembered for a tool, an action and an
  environment.** Approving a deploy to one test environment does not approve a
  deploy to another.

## Classification rules

- **`param` is a top-level parameter of the call.** Strings, numbers and
  booleans are compared as text. `value` must match exactly; `pattern` is a
  regular expression.
- **`action`, if given,** must equal the call's own `action` parameter, and
  becomes the action of the result.
- **The first matching rule wins,** yours before a company plugin's. A rule
  beats Pi's built-in defaults, so a rule on `bash` can reclassify a command.

## Secret references

| Reference | Backend | What it reads |
|---|---|---|
| `pass:<entry>` | [pass](https://www.passwordstore.org/) | The first line of the entry. Entry names use letters, digits and `. _ @ + - /` |
| `env:<NAME>` | the environment of the Pi process | The variable's value |
| `keychain:<service>/<account>` | the macOS Keychain | `security find-generic-password -s <service> -a <account> -w`. The service is the part before the first `/` |
| `op://<vault>/<item>/<field>` | the 1Password command-line tool | `op read`, with an optional section before the field |

A reference whose backend is not in `secrets.backends` is an error that says
so. Every backend has a timeout, 60 seconds by default, which includes the time
you need to unlock a store. An error never repeats the reference or a value.

## Sections of other plugins

The file is shared. Each Jig plugin keeps its settings in a section of its own,
such as `git`, `lens` or `memory`.
- **A plugin registers its section** with `config.registerSection(name,
  validate)`, from `withJig()` in its factory, and reads it back with
  `config.section(name)`. `validate` returns error messages that name the key.
- **At session start,** jig-core checks each registered section that is in the
  file. A section that fails is reported with the file and the key, `section()`
  returns `undefined`, and the plugin uses its defaults. The rest of the file
  still loads.
- **A top-level key that neither jig-core nor a plugin registered** is an
  unknown field.
- **A plugin cannot register a name jig-core uses itself:** `environments`,
  `rules`, `classify`, `secrets`, `records`, `spill`.
- **Order does not matter.** A plugin that loads before jig-core waits for it,
  and a section registered after the file was read is checked at once.

## Environment variables

| Variable | Meaning |
|---|---|
| `JIG_STATE_DIR` | The state folder. Default: `${XDG_STATE_HOME:-~/.local/state}/jig`; an empty or relative `XDG_STATE_HOME` is ignored. Folders are private (0700) and files too (0600) |
| `JIG_AGENT_ROLE` | The role of this agent, such as `reviewer`. Default: `main`. Written to every record. A child agent is started with it set |
| `JIG_PARENT_SESSION` | The session that started this one. Written to every record of a child agent |
| `PI_CODING_AGENT_DIR` | Pi's own setting for its agent folder, and so for where `jig.json` is |
| `BROWSER` | The program that opens a rendered preview. A name, optionally with arguments, and `%s` for the address. Default: `xdg-open`, or `open` on macOS |
