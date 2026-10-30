# jig-sandbox: the agent's shell, in a sandbox that stays out of the way

**Status: design.** Built on [Anthropic's sandbox runtime](https://github.com/anthropics/sandbox-runtime)
(Apache-2.0): bubblewrap on Linux and WSL2, Seatbelt on macOS.

`jig-sandbox` runs the `bash` commands the agent sends inside an operating-system
sandbox, and keeps two promises:
- **the agent cannot read your credentials:** SSH keys, cloud and cluster logins,
  tokens, the secret files of your projects;
- **the agent cannot plant anything that runs later outside the sandbox:** in your
  shell start-up files, your `PATH`, git hooks, Pi's settings, build init scripts.

Everything else works as it does outside: builds and their caches, git, package
installs, the network, servers on `localhost`. When a command does hit a rule, it
says which rule and why, and offers a way through.

![Pi, Jig's tools, your own commands and the broker run on the host; the agent's bash runs in the sandbox, where paths are hidden, locked, ask-first or writable](../../docs/img/sandbox-boundary.svg)

*Where the line runs. Your own `!` commands and Jig's tools stay outside; only what the agent runs in `bash` is inside, and the hidden paths are the same list `jig-core` protects from Pi's file tools.*

## Inside and outside

| Inside the sandbox | Outside it |
|---|---|
| The agent's `bash`, foreground and background | Your own `!` commands: they are yours |
| Subagents' `bash` | Jig's tools (`git`, `jira`, `mongo`, ...), through `jig-core`'s rules |
| | Pi itself and its file tools, which `jig-core`'s protected paths cover |

## The four kinds of path

| Kind | Examples | Inside the sandbox |
|---|---|---|
| **Hidden** | `~/.ssh`, `~/.aws`, `~/.kube`, `~/.config/gh`, Pi's `auth.json`, a project's `.env`, `~/.gradle/gradle.properties`, the Windows drive | Cannot be read. Never asks |
| **Locked** | `~/.bashrc`, `~/.gitconfig`, `PATH` folders, git hooks, Pi's agent folder, a project's `.pi/extensions`, `~/.gradle/init.d` | Readable, never written. Never asks |
| **Ask first** | Toolchain managers (`~/.sdkman`, `~/.nvm`, `~/.pyenv`, ...) | Writable once you say yes |
| **Writable** | The project, your home folder, `/tmp`, build caches (`~/.gradle/caches`, `~/.m2/repository`, `~/.npm`) | As outside |

Hidden and locked are exact lists, shared with `jig-core`'s protected paths, and
everything not on them is writable. Every entry and its reason is in [The rules](docs/rules.md).

## When a command hits a rule

- **It says why, and what to do instead.** For example: `cannot read ~/.ssh: it holds
  credentials. Use the git tool for fetch, pull and push; it signs in outside the
  sandbox.`
- **A folder that is not locked asks you.** If a command was stopped from writing
  `~/.sdkman`, Pi asks: *allow writes there for this session, always, or no?* Say yes
  and the agent runs it again. With no screen to ask on, the answer is no.
- **Git config keeps working.** `git config` and `git remote add` work in the sandbox.
  If a command adds a setting that would run a program outside it (`core.fsmonitor`,
  an alias starting with `!`, a filter), `jig-sandbox` puts the file back as it was
  and says what it removed.
- **Your own `!` commands are never sandboxed,** and `/sandbox off` turns it off for
  this session if you need to. The footer then says so.

[When a command hits a rule](docs/when-blocked.md) has every message and its way through.

## Network

| Mode | What it does |
|---|---|
| `open` (default) | The machine's own network, as outside: every host, plain DNS, `localhost`, servers started by earlier commands |
| `filtered` | Through the sandbox's proxy: every public host, except cloud metadata addresses, private and `localhost` addresses, and hosts on `deny`. A background task's server and `localhost` ports you list are still reachable |
| `ask` | `filtered`, and a new host waits while Pi asks you: once, this session, always or no |
| `off` | No network |

In every mode, `ssh` has no keys (they are hidden), so git over SSH goes through Jig's
`git` tool, and Unix sockets are closed, the Docker socket included: through Docker
a command could run anything as root. `docker: true` opens that one socket,
knowingly.

**When to choose `filtered`.** In `open` mode a command can reach anything on this
machine's `localhost`, including a tunnel `jig-core` opened for a database. If your
tunnels lead to production, `filtered` keeps bash away from them.

## Background tasks

`bash` with `background: true` starts a server, a watcher or a long build and returns
at once. The agent reads its output, lists and stops tasks, and is woken when a task
ends or prints a line you asked to watch for. `/ps` shows them; the footer counts
them. Tasks run in the sandbox too, and stop when the session ends. Details in
[Background tasks](docs/background.md).

## Fails closed, says so

- When the sandbox cannot start, `bash` is refused with the steps to fix it. It never
  runs unsandboxed by accident.
- `/sandbox doctor` checks each requirement and runs real commands inside to prove it:
  a write, a hidden read, a DNS lookup, a `localhost` connection.
- Without `jig-sandbox`, `bash` runs as Pi runs it, and `/jig` says plainly that
  credentials are then hidden only from Pi's file tools.

## Commands

| Command | What it does |
|---|---|
| `/sandbox` | Whether bash is sandboxed, every rule and where it came from |
| `/sandbox doctor` | Checks the requirements and runs the proof commands |
| `/sandbox allowed` | Folders and hosts you allowed always; `forget <path or host>` |
| `/sandbox off`, `/sandbox on` | Turns it off or on for this session only |
| `/ps` | Background tasks: output, stop |

## Configure

In `~/.pi/agent/jig.json`, under `sandbox`. Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `share` | none | Folders writable although a rule says otherwise, such as a Windows work folder under `/mnt` |
| `hide`, `lock` | none | More hidden or locked paths |
| `network.mode` | `open` | `open`, `filtered`, `ask` or `off` |
| `network.allow`, `network.deny` | none | Hosts, with `*.example.com` and an optional `:port` |
| `network.localhost` | none | `localhost` ports reachable in `filtered` and `ask`, such as a local database |
| `env.keep` | none | Variables passed in although their names look like credentials |
| `docker` | `false` | Opens the Docker socket |
| `background` | 4 tasks, 4 hours | `maxTasks`, `maxRuntimeMinutes` |

## Install

Linux and WSL2: `sudo apt install bubblewrap socat ripgrep`. macOS: `brew install ripgrep`.
Native Windows is not supported yet.

## Company part (in the company plugin)

Hosts to deny (production databases) and to allow in `ask` mode, and more hidden or
locked paths, through `jig-core`'s section defaults and protected paths.

## Later

- **Stand-in credentials:** a command gets a placeholder, and the proxy puts the real
  value back only on the way to an allowed host, so a build can reach a private
  repository without ever seeing its token.
- Native Windows.

## More detail

- [The rules](docs/rules.md): every hidden, locked and ask-first path, and why
- [When a command hits a rule](docs/when-blocked.md): the messages, the prompts, the ways through
- [Background tasks](docs/background.md): the tools, limits, waking, `/ps`
- [Design](docs/design.md): how it is built, what the earlier sandbox taught us, the tests
