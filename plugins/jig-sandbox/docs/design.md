# Design

How `jig-sandbox` is built, what the earlier sandbox and a spike on a real machine
taught, and how it is tested. Back to the [jig-sandbox overview](../README.md).

## Principles

1. **Two promises, held hard.** The agent's shell never reads a credential, and never
   writes anything that runs later outside the sandbox. Configuration cannot bend
   them: `share` cannot open a hidden credential path.
2. **Everything else works as outside.** The default is writable, with exact lists of
   what is hidden or locked, because an allow-only sandbox breaks every tool that keeps
   state in a folder nobody thought to list.
3. **No dead ends.** Every block names its rule, its reason and the way through. A
   folder that is not locked asks you instead of refusing.
4. **Fail closed, say so.** If the sandbox cannot start, bash is refused, never run
   bare by accident; when the plugin is not installed, Jig says bash is not sandboxed.
5. **Test against the real machine.** Rules are tested as data, and escapes by running
   real commands in the real sandbox.

## How it fits together

```text
agent calls bash
  -> jig-core's rules (bash: local write, allowed)
  -> jig-sandbox's bash tool: Pi's createBashToolDefinition with a spawn hook
       rules   = jig-core's protected paths + the lists + your config + your approvals
       before  = snapshot of locked paths that do not exist yet, hooks, .git/config
       wrapped = the session broker wraps the command (sandbox runtime)
       env     = the session environment, credentials removed
  -> Pi spawns the wrapped command in the project; output streams as usual
  -> after: the broker cleans up after the command
            audit: locked paths created, new hooks, program-running git settings -> undone, reported
            blocks explained: network from the runtime's records, files from the error lines
            an ask-first folder was refused -> Pi asks you -> the rules widen
  -> output cleaned (escape codes), scrubbed (credential values), capped (Pi's limits)
```

### The broker: the runtime never runs inside Pi

The sandbox runtime runs in a small Node process, one per Pi session, that
`jig-sandbox` starts at session start and stops at shutdown. Pi asks it over a pipe
to wrap each command, then spawns the wrapped command itself. The spike showed why:
- **No stray files in your repository.** The runtime's built-in protections are
  placed relative to the working folder of the process running it, and for names that
  do not exist (`.bashrc`, `.vscode`, `.claude`) it creates empty placeholder files
  there until the command is cleaned up. Inside Pi that folder is your project, where
  `git status` would show them and `git add -A` could commit them. The broker's working
  folder is the session's private folder, so they land there. `jig-sandbox` lists the
  project's own sensitive files itself.
- **Signals stay Pi's.** The runtime installs `SIGINT` and `SIGTERM` handlers that
  reset it and keep the process alive. In the broker that is harmless; in Pi it could
  keep a closed session running.
- **A failure stays contained.** If the runtime throws or hangs, the broker is
  restarted and the command refused; Pi is unaffected.

The broker is started with the Node that runs Pi, from the plugin's own files, and
its pipe is private to the Pi process. It holds no credentials.

### Pinned, and upgraded on purpose

`@anthropic-ai/sandbox-runtime` is pinned to an exact version at least two weeks old;
it is still `0.0.x`. An upgrade is its own change, with the escape tests run on it.

## Mapping the rules onto the runtime

| Rule | Runtime setting |
|---|---|
| Hidden | `filesystem.denyRead`, as literal absolute paths, with symbolic links resolved first; computed from your real home folder (the password database's), not `$HOME`, because `ssh` and Java use that one |
| Writable by default | `filesystem.allowWrite`: your home folder, the working folder (also when outside home), `/tmp`, the session's private temporary folder, `share` |
| Locked | `filesystem.denyWrite`, which wins over `allowWrite` |
| Ask first | `filesystem.denyWrite` until you approve, then left out of it |
| `/mnt/wsl/resolv.conf`; `share` under a hidden path | `filesystem.allowRead` (and `allowWrite` for `share`), always on the real file, never on a link to it: an allowed link binds its target's content at the link's place |
| `.git/config` writable | `filesystem.allowGitConfig: true`, with the audit below |
| Unix sockets closed | the runtime's socket filter (seccomp); `docker: true` allows the Docker socket's path only. `allowAllUnixSockets` is never set: on WSL it would let a command start Windows programs |
| Network `open` | no `network.allowedDomains` at all: the runtime then leaves the network namespace alone |
| Network `filtered`, `ask` | `network.allowedDomains` set, the proxy on, and an ask callback (below) |
| Network `off` | `strictAllowlist` with an empty allow list |
| Temporary folder | the runtime's temporary folder variable set to the session's private folder (its default, `/tmp/claude`, does not exist on most machines) |

Runtime limits that shape the rules:
- **Literal paths only on Linux** for write rules, and a rule for a path that does not
  exist does nothing. So rules are computed from what exists when the command is
  wrapped, and the audit covers what a command creates.
- **A hidden directory** appears empty inside; a hidden file appears empty.
- **Name resolution in `filtered` mode** happens in the proxy, on the host: HTTP
  clients work, while `dig`, `getent` and programs that ignore proxy settings find no
  names. `open` mode has plain DNS.

## Network

### `open`: the machine's network

The command shares the machine's network namespace, as in the earlier harness:
servers it starts are reachable by later commands and by you, `localhost` services
work, and DNS is plain. Two consequences, stated in the README: the cloud metadata
address cannot be blocked, and a tunnel `jig-core` opened on `localhost` is reachable.

### `filtered` and `ask`: through the proxy

Each command gets a network namespace of its own; every connection goes through the
runtime's proxy, which asks a callback about each host no list decides. The callback
is `jig-sandbox`'s:
- **Always refused:** cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`,
  `metadata.google.internal`), and loopback, link-local, private (RFC 1918), carrier
  (100.64.0.0/10) and this machine's own addresses, unless a port is listed in
  `network.localhost`. The spike showed that an approved IP address is dialled with no
  further check, so the callback must refuse these itself.
- **`deny`:** refused, with the reason in the refusal.
- **`filtered`:** everything else allowed.
- **`ask`:** everything else asks you, while the connection waits.

### `localhost` across commands, in `filtered` and `ask`

Separate namespaces mean a server in one command is not at `localhost` in the next.
`jig-sandbox` bridges what should be:
- **Background tasks:** the broker watches each task's listening ports (from its
  namespace's `/proc/<pid>/net/tcp`) and, for each, opens a Unix socket in the
  session folder. Every later command starts with a small forwarder that listens on
  the same port inside its namespace and carries it to that socket. You reach the
  server too, at the same port on the host.
- **`network.localhost`:** host ports you list (a local database, say) are bridged into
  every command the same way.
- `jig-core`'s tunnel ports are never bridged unless you list them.

## The audit after each command

What the runtime cannot prevent, `jig-sandbox` undoes and reports:
- **A locked path that did not exist** (`~/.zshrc` on a machine without zsh, a Gradle
  `init.d` script folder): created during the command, it is removed.
- **Hooks in a repository the command created:** a repository made by `git init`
  inside the command has no protection until the next command, so new files in any
  watched repository's `.git/hooks` (other than the `*.sample` files) are removed.
- **Program-running git settings:** each watched repository's `.git/config` and
  `config.worktree` are compared with the snapshot; new keys from the list in
  [When a command hits a rule](when-blocked.md#git-configuration) are taken out, and
  the rest of the change stays.

Watched repositories are the working folder's and those one and two levels below it.
Each removal is one line to the agent and a notice to you.

## Explaining a block

- **Network:** the runtime records each refusal with its host and reason, read by
  command id.
- **Files:** the runtime does not record file refusals. `jig-sandbox` reads the
  command's error lines (`Read-only file system`, `Permission denied`, `Device or
  resource busy`, `No such file or directory` for hidden paths), takes the paths they
  name, and matches them against the rules. A path it can match gets its rule and way
  through; otherwise one general line points at `/sandbox`.
- **Ask first:** a refused write whose path is under an ask-first folder raises the
  question; several for the same folder are one.

## Asking you

- **Writes:** after the command, inside the waiting tool call, as every Jig approval
  is. The answer widens the rules from the next command; the agent is told to run it
  again.
- **Hosts:** in `ask` mode, during the connection, through the same queue as `jig-core`'s
  approvals, so two questions never overlap.
- **No screen:** the answer is no, and the line says how a person allows it.
- **Kept answers:** `<agent folder>/jig-sandbox/allowed.json`, which Pi's file tools
  and the sandbox can only read. `/sandbox allowed` lists and forgets them.

## Environment

- **Removed:** variables whose names look like credentials, matched without regard to
  case: `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*PASSWD*`, `*_KEY`, `*APIKEY*`,
  `*CREDENTIAL*`, `AWS_*`, `AZURE_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GH_*`, `GITHUB_*`,
  `NPM_TOKEN`, `VAULT_*`, `KUBECONFIG`, and the sockets `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`,
  `DBUS_SESSION_BUS_ADDRESS`, `WSL_INTEROP`. `env.keep` passes a named one through.
- **Scrubbed from output:** the values of the removed variables, and every secret
  `jig-core` resolved this session.
- **Added by the runtime** in `filtered` mode: the proxy variables, `JAVA_TOOL_OPTIONS`
  with its Java proxy agent (Gradle and Maven then use the proxy), and a
  `GIT_SSH_COMMAND` for its proxy.

## What jig-core gains

| Addition | Use |
|---|---|
| `jig().protectedPaths.list()` | The sandbox reads the protected paths, with kind and source, so both share one list |
| `jig().sandbox.register(provider)` | The sandbox says it is active and answers `canWrite(path)` |
| `exec.run` checks `canWrite` | A program in a folder the sandbox lets bash write is refused, so a planted `git` never runs outside |
| `/jig` and session start | Say whether bash is sandboxed, and in which network mode |

## What the earlier sandbox and the spike taught

| What happened | What this design does |
|---|---|
| A `PATH` folder that did not exist made bubblewrap stop every command | Rules only for paths that exist; nothing mounted or created in other programs' folders; a start-up probe runs a real command with your real environment |
| Hiding the Windows drive broke name resolution on WSL | `open` keeps plain DNS; `/mnt/wsl/resolv.conf` stays readable; the doctor resolves a name |
| A read-only `.git/config` broke `git config` and `git remote add` | Writable, with program-running settings audited away |
| A protected `.pi` stopped the agent keeping `.pi/docs` current | Only what Pi loads is locked |
| Read-only toolchain folders stopped JDK and Node installs | They ask first |
| Gradle could not lock its wrapper download | Gradle's folders are writable; only its init scripts and credentials are not. A Gradle build ran in the spike, with its proxy agent |
| The agent rewrote code with scripts in bash, out of sight of reviews | The bash description says to change code with `edit` and `write` |
| October audit: project `.pi/extensions` and git hooks were writable | Both locked, plus the audit for repositories made during a command |
| Spike: the runtime's placeholders appeared in the project | The broker |
| Spike: `HOME` does not redirect `ssh`, which used the real keys | Hidden paths come from the real home folder |
| Spike: an approved IP address skips the runtime's address checks | The callback refuses private and local addresses itself |
| Spike: a separate network per command | `open` shares the machine's; the bridge in `filtered` |
| Spike: file refusals are not recorded | Explained from the command's error lines |

## Performance

From the spike on WSL2: starting the runtime takes about 130 ms, once per session.
Each command adds about 45 ms (13 ms to wrap, the rest to start the sandbox), and
about 18 ms more in a working folder of 20,000 files. Twenty commands in parallel ran
without errors.

## Tests

- **Rules as data:** for a given home, working folder and environment, the computed
  runtime configuration, with links, missing paths, WSL and macOS layouts, company
  additions and your config.
- **Escapes, run for real** in the real sandbox, with fake credentials made at run
  time in the real home's places mapped to a test folder. Each must fail: read
  `~/.ssh/id_*`, `~/.aws/credentials`, Pi's `auth.json`, a project `.env` (also through
  a symbolic link); write `~/.bashrc`, a missing `~/.zshrc` (audited away),
  `~/.gradle/init.d/x.gradle`, `.git/hooks/pre-commit` (also in a repository made in the
  same command), `.pi/extensions/x.ts`, a program into a `PATH` folder, Pi's agent
  folder; set `core.fsmonitor` (audited away); connect to a Unix socket and to the
  Docker socket; read the Pi process's environment through `/proc`; reach
  `169.254.169.254` and `127.0.0.1` in `filtered`; run a Windows program on WSL; create
  a user namespace.
- **Keeps working, for real:** a Gradle build (wrapper and caches), `npm install`,
  `git init/add/commit/branch/config/remote add`, `curl` to a public host, a background
  server reached by the next command in each network mode, no file left in the project
  that the command did not write.
- **Pi itself:** a session with the plugin starts, runs commands, and exits on
  `SIGTERM` and on quitting.
- **CI:** Ubuntu with bubblewrap, `socat` and ripgrep, unprivileged user namespaces on,
  runs the escape and keep-working tests on every push.

## Build order

1. The broker, rules, bash tool, environment, explanations, `/sandbox`, the doctor, and
   the jig-core additions. `open` and `off` network modes.
2. The audit and asking you (writes).
3. Background tasks and `/ps`.
4. `filtered` and `ask`, with the callback and the `localhost` bridge.

Each step ships with its escape and keep-working tests.
