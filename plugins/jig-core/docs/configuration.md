# Configuration reference

The fields of `jig.json`, with their limits, how rules and classification rules
match, secret references, the sections other plugins keep in the same file, and
the environment variables. Back to the [jig-core overview](../README.md#configure).

## The fields

- **`environments`:** a `kind` is `test` or `production`. A test environment can
  set `mask: true`; production masking cannot be turned off. Built-in names
  cannot be redefined, and an environment a company plugin made production
  cannot be lowered.
- **`rules`:** most specific first. A rule names a `tool`, optionally an
  `action`, `environment`, `effect` or `command` (a pattern for the call's
  `command`, see [Rules](#rules)), and a `decision` (`allow`, `ask` or `deny`),
  and optionally an `approval` kind (`dialog`, `review` or `form`). A rule that
  would lower the floor is refused at load, naming the file and the key.
- **`classify`:** a `tool`, optionally an `action`, a `param` with a `value` (or
  a `pattern`), and the resulting `environment` and `effect`.
- **`protectedPaths`:** `{ "secret": [...], "guarded": [...] }`, each path
  absolute or starting with `~/`. A secret path is neither read nor written; a
  guarded one can be read but not written. Nothing removes a default (see
  [Protected paths](#protected-paths)).
- **`secrets.backends`:** `pass`, `env`, `keychain`, `op`, `cmd` and `file`.
  Only `pass` is on by default.
- **`secrets.disabledBackends`:** the same names. A backend listed here is off,
  whoever turned it on, a company plugin included (see
  [Secret references](#secret-references)).
- **`secrets.commands`:** the program, then its arguments, such as
  `{ "gh": ["gh", "auth", "token"] }`. Used only when `cmd` is in
  `secrets.backends`.
- **`records.retentionDays`** and **`spill.retentionDays`:** whole numbers of
  days, from 1 to 3650.

## The `/jig` commands

- **`/jig`** shows the tools governed, whether `bash` is sandboxed and in which
  network mode (with no sandbox it says plainly that it is not), the plugins
  loaded, the environments and who defined them, the tools still on the unknown
  default, and the open watches (and how many are paused or wait
  for their plugin). It also shows the configuration file with the state of each
  plugin section, lines that plugins registered (such as `jig-mongo` saying that
  its index check is off), configuration errors, a failed records write, and
  problems with saved watches.
  - **A section is `loaded`,** `company defaults incomplete` (waiting for the part
    only you can give), or `not set`: no company default and nothing in your file.
  - **`not set or invalid`** means your file has the section and it failed the
    plugin's check (the problem is listed under it), or the file could not be read
    at all.
- **`/jig rules [tool]`** shows the effective decision per tool and action,
  with where each came from: declaration, rule, hint or default.
  - A tool whose schema lists its actions gets a line for each.
  - A declared tool that classifies from the call itself says so, unless it gave
    `examples`, which add a line for each action it picks from its input, such as
    `bash outside`.
  - The protected paths of the file tools follow, each with its source: default,
    your `jig.json` or a company plugin.
- **`/jig records`** shows where today's records are, and a one-line summary:
  calls (with errors and blocked ones), questions asked, time waited for you,
  and model turns.

## Rules

- **The first rule that matches decides.** List them most specific first. Your
  own rules come before the ones a company plugin adds, so yours win.
- **`tool` may use `*`** for any run of characters, as in `mcp__db__*`.
  `action`, `environment` and `effect` match exactly. A field you leave out
  matches anything.
- **A rule that would lower the floor is refused,** with the file and the key
  named, and the rest of the file still loads. That means a rule that names a
  production environment and allows or asks for a write there.
  - A rule with no `effect` counts as covering writes, so give a production rule
    `effect: "read"`.
  - An environment name nobody defined counts as production.
- **A wildcard rule cannot allow a tool that nothing classified.** Name the
  tool exactly, or classify it.
- **`command` is a pattern for the `command` the call carries** (a `bash`
  command). `*` stands for any run of characters that holds no `;`, `&`, `|`,
  `<`, `>`, backquote, `$(` or line break, so a pattern that allows
  `docker compose *` allows no second command chained after it. A call with no
  `command` never matches a rule that has one.
- **Only a rule that names it allows `bash` outside its sandbox:** the tool
  `bash`, the action `outside` and a `command` that names something, such as
  `{ "tool": "bash", "action": "outside", "command": "docker compose *",
  "decision": "allow" }`. No wildcard rule and no default ever does; a rule that
  tries is refused at load. Everything else asks, and with no screen it is
  refused (see [Running one command outside](plugin-contract.md#running-one-command-outside)).
- **"Allow for this session" is remembered for a tool, an action and an
  environment.** Approving a deploy to one test environment does not approve a
  deploy to another. For `bash` outside its sandbox it is remembered for the
  exact command text.

## Classification rules

- **`param` is a top-level parameter of the call.** Strings, numbers and
  booleans are compared as text. `value` must match exactly; `pattern` is a
  regular expression.
- **`action`, if given,** must equal the call's own `action` parameter, and
  becomes the action of the result.
- **The first matching rule wins,** yours before a company plugin's. A rule
  beats Pi's built-in defaults, so a rule on `bash` can reclassify a command.

## Protected paths

Pi's own file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) refuse some
paths. This is part of the floor: `protectedPaths` in `jig.json` and
`config.addProtectedPaths` in a company plugin can **add** paths, and nothing
removes one. `/jig rules` lists them all, each with where it came from
(default, your `jig.json`, a company plugin).

```json
{
  "protectedPaths": {
    "secret": ["~/.config/other-cli", "/srv/keys"],
    "guarded": ["~/dotfiles"]
  }
}
```

- **Two kinds.** `secret`: no reading and no writing. `guarded`: reading is
  allowed, writing is not.
- **Each entry** is an absolute path or starts with `~/`. A relative entry is an
  error that names the key. A path listed as `guarded` that is already `secret`
  stays `secret`, and one listed as `secret` that is guarded becomes `secret`.
- **Built in.** The list of secret and guarded defaults is in
  [Permissions](../../../docs/permissions.md#protected-paths).
- **Matching.**
  - `~` is expanded and a relative path starts from Pi's working folder.
  - `..` is folded away, as Pi does before it opens a file, and also read from a
    link's target, as the system does.
  - Symlinks are followed through the longest existing part. A link that points
    at nothing yet is followed too, because a write through it creates its
    target.
  - A path equal to a protected path or inside one matches; a protected path
    that is itself a link matches by its real place too.
  - On Windows and macOS case is ignored; on Linux it counts.
- **Per tool.**

  | Tool | Refused |
  |---|---|
  | `read` | inside a secret path |
  | `grep` | inside a secret path, or when the folder it searches contains one |
  | `find`, `ls` | inside a secret path |
  | `write`, `edit` | inside a secret or a guarded path |

  Searching `~` with `grep` would read `~/.ssh`, so the message says to search
  a narrower folder; without a `path`, the working folder is the one searched.
  `find` and `ls` list names only, so a folder that contains a secret path is
  fine.

- **A refusal** is a deny with one line that names the protected path and never
  shows content. The record says `decisionSource: "floor"`.
- **Not covered.**
  - `bash` and `powershell` are the sandbox's job: until a sandbox runs, a
    shell command can still read and write these paths. `jig-sandbox` hides the
    same list from `bash`, through `protectedPaths.list()`.
  - Variables that move a tool's folder (`GH_CONFIG_DIR`, `CLOUDSDK_CONFIG`) are
    not read: list that folder yourself.
  - The check is made when the call starts, so a link swapped afterwards by a
    shell command is not seen.

## Secret references

| Reference | Backend | What it reads |
|---|---|---|
| `pass:<entry>` | [pass](https://www.passwordstore.org/) | The first line of the entry. Entry names use letters, digits and `. _ @ + - /` |
| `env:<NAME>` | the environment of the Pi process | The variable's value |
| `keychain:<service>/<account>` | the macOS Keychain | `security find-generic-password`; the service is the part before the first `/` |
| `op://<vault>/<item>/<field>` | the 1Password command-line tool | `op read`, with an optional section before the field |
| `cmd:<name>` | a command you declared by name | The trimmed standard output of the command declared as `<name>`. See below |
| `file:<absolute path>` | a file | The first line of the file, trimmed. A leading `~/` is the home folder. See below |

A reference whose backend is not on is an error that says so. Every backend has a
timeout, 60 seconds by default, which includes the time you need to unlock a store.
An error never repeats the reference or a value.

**Which backends are on.** The ones in your `secrets.backends` (`pass` alone when you
list none), plus the ones a company plugin turned on with
`config.enableSecretBackends`, less the ones in your `secrets.disabledBackends`.
- **The company only adds.** A company plugin is code that already runs in Pi with
  your rights, so turning a backend on gives it nothing it lacked. Its `cmd`
  backend still runs only commands that were declared by name, and `file` still
  refuses Pi's agent folder.
- **You have the last word.** A backend in `secrets.disabledBackends` stays off
  whoever turned it on, and the error says you turned it off.
- **`/jig` shows it:** `Secret backends on: pass, cmd (cmd enabled by a company
  plugin); turned off by you: env`.

### `cmd`: a command that owns the login

`cmd:gh` runs a command that you declared by name, so the tool that owns a login
does it and Jig stores nothing. Declare commands in `secrets.commands` of
`jig.json` (a company plugin can add more with `config.addSecretCommands`), and
turn the backend on:

```json
{
  "secrets": {
    "backends": ["pass", "cmd"],
    "commands": { "gh": ["gh", "auth", "token"] }
  }
}
```

- **Off by default,** like every backend but `pass`: `cmd` must be in
  `secrets.backends`, or a company plugin must have turned it on.
- **A name, never a command line.** A reference names a declared command. An
  undeclared name is refused (and not repeated in the error), so a model cannot
  slip in a command of its own through a parameter.
  - A command is the program, then its arguments, as a list; no shell is used.
  - A name is letters, digits and `. _ -`.
  - Your own declaration of a name replaces a company's.
- **What it uses.** The trimmed standard output, which must be non-empty and at
  most 16 KiB.
- **How it runs.** Through `jig-core`'s own exec, with the same timeout as the
  other backends and a short environment:
  - the usual variables;
  - the ones a keyring or a pinentry needs to show its prompt;
  - the ones that say where `gh`, `glab`, `gcloud`, `aws` and `kubectl` keep
    their configuration.

  Tokens in Pi's environment are not passed on.
- **Errors show the exit code and nothing else.** The command's error output is
  never shown, because it may hold the very value being read.

### `file`: the first line of a file

`file:/home/me/.config/orders-api/token` and `file:~/.config/orders-api/token`
read the first line of a file, for a credential that another tool keeps up to
date.

- **Off by default:** `file` must be in `secrets.backends`, or a company plugin must
  have turned it on.
- **A regular file,** at most 64 KiB, whose first line is not empty. The path
  must be absolute, or start with `~/`. Permission bits are not checked: files
  on a Windows drive seen from WSL all show 0777.
- **Never Pi's agent folder,** not by its path and not through a link: the
  files there are Pi's own sign-in, and a reference must not be a way to read
  them.
- **Errors say what is wrong** (not there, not a file, too large, empty) and
  never show the content.

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
- **A company can give defaults for a section** with
  `config.addSectionDefaults(name, defaults)`. Your section is laid over them
  before the plugin's check runs, so you write only what you change.
  - **Objects merge key by key.** Any other value of yours replaces the
    company's: a list, a string, a number.
  - **A plugin names keys that replace instead,** with
    `registerSection(name, validate, { replace: ["auth"] })`. Where an object is
    one choice among several, such as an `auth` of `{ transport }` or of
    `{ token }`, yours takes its place whole, and the two never make a mix.
  - **A key is a path from the section's root,** with `*` for any one name:
    `auth`, `backend.auth`, `services.*.ci.auth`. It matches at that depth only.
  - **A plugin names keys that exclude each other,** with
    `{ oneOf: [["backend.auth", "backend.transport"]] }`. When you set one of
    them, the company's value for the others is dropped. For example, your own
    `backend.auth` removes the company's `backend.transport`.
  - **A plugin names lists that add up,** with `{ union: ["folders"] }`. The company's
    entries come first, then yours, each once, so a list of yours does not take the
    company's away. Any other list of yours still replaces theirs.
  - **A section with no defaults is checked as you wrote it,** as before.
- **Defaults can lack what only you can give.** With no section of yours, the
  defaults alone are checked. When they are not valid, the plugin is not
  configured: no problem is reported at start-up, and `/jig` says the company
  defaults are incomplete, with the check's messages. Write your part and it
  works.
- **Defaults and your section that do not fit** are a problem with the file
  and the key. If your section is complete without the defaults, the plugin
  gets it as you wrote it; if not, it gets nothing.
- **A top-level key that neither jig-core nor a plugin registered** is an
  unknown field.
- **A plugin cannot register a name jig-core uses itself:** `environments`,
  `rules`, `classify`, `protectedPaths`, `secrets`, `records`, `spill`.
- **Order does not matter.** A plugin that loads before jig-core waits for it,
  and a section or defaults registered after the file was read are applied at
  once.

## Environment variables

| Variable | Meaning |
|---|---|
| `JIG_STATE_DIR` | The state folder (see below) |
| `JIG_AGENT_ROLE` | The role of this agent, such as `reviewer`. Default: `main`. Written to every record |
| `JIG_PARENT_SESSION` | The session that started this one. Written to every record of a child agent |
| `PI_CODING_AGENT_DIR` | Pi's own setting for its agent folder, and so for where `jig.json` is |
| `BROWSER` | The program that opens a rendered preview (see below) |

- **`JIG_STATE_DIR`:** the default is `${XDG_STATE_HOME:-~/.local/state}/jig`. An
  empty or relative `XDG_STATE_HOME` is ignored. Folders are private (0700) and
  files too (0600).
- **`JIG_AGENT_ROLE`:** a child agent is started with it set.
- **`BROWSER`:** a name, optionally with arguments, and `%s` for the address.
  The default is `xdg-open`, or `open` on macOS.
