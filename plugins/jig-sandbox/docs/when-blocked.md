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
| Use Docker | `docker: true` in the `sandbox` section, if you accept that Docker is root |
| Anything else that must run unsandboxed | Your own `!` command, or `/sandbox off` for this session |

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
  says that a person can allow it with `/sandbox allowed add`.
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
  `credential.helper`, `include.path`, `includeIf.*`) is removed, the rest of the change
  stays, and the agent and you are told which one;
- settings that were there before the command are left alone.

Jig's own `git` tool also refuses to run in a repository whose config runs a program,
so even a setting that slipped in between is not run by Jig.

## Turning it off

`/sandbox off` is yours alone: the agent cannot run commands. It lasts for this
session, the footer shows `bash: not sandboxed` in red while it is off, and
`/sandbox on` or a new session turns it back on.
