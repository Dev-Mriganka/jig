# Running programs

How `jig-core` runs the programs that Jig's tools need, such as `git`, `gh` and
the secret backends. Back to the [jig-core overview](../README.md).

These programs run outside the sandbox, with your credentials, so a plugin
starts them with `exec.run(file, args, options)` or `exec.git(repo, args,
options)` and never through a shell.

## Programs

- **No shell.** A program starts from an argument list. A name is looked up on
  `PATH`; anything else must be an absolute path.
- **A short environment.** The allow-list is `PATH`, `HOME`, `USER`,
  `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR` and the XDG folders
  (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`),
  plus what the calling tool passes. Nothing else of Pi's environment reaches
  the program.
- **Only programs the agent did not plant.** A program found only in a folder
  the agent can write to is not run, and such a folder is left out of `PATH`.
  The agent's shell can write Pi's working folder and, with a sandbox
  registered, every place the sandbox lets `bash` write, such as `~/.local/bin`
  when it is not locked. A program is judged by its real path, so a link
  into such a place does not get it past, and an absolute path is checked too.
- **A timeout, and an output cap.** A program that takes too long (60 seconds
  unless the caller sets it) is stopped with its whole process group, and the
  result has `timedOut: true` and exit code 124. Output beyond the cap (10 MiB
  unless the caller sets it) is cut, and ends with `[output cut at N bytes]`.
- **No terminal.** A program has no controlling terminal, so `ssh` or `gpg`
  cannot prompt on Pi's screen. Programs still running when Pi exits are
  stopped.

## Git

- **Git runs with hooks and `core.fsmonitor` off and prompts disabled.** The
  fixed settings also turn off the pager and colour, and allow only the file,
  git, https and ssh protocols. Git also gets your ssh agent and ssh command
  (`SSH_AUTH_SOCK`, `GIT_SSH`, `GIT_SSH_COMMAND`) and the variables that name
  its own configuration files.
- **A repository whose own configuration would run a command is refused.** The
  agent's shell can write `.git/config`, and git runs here with your
  credentials, so a command or a redirect planted there would run on the next
  fetch or push.
  - Before git runs in a repository, its local and per-worktree configuration
    is read, and the call is refused in one line that names the file and the
    key.
  - Your global and system configuration are not checked, and neither is
    `git clone`, which makes a new repository.
- **`gh` and `glab` get the same checks.** `exec.run("git", ...)`,
  `exec.run("gh", ...)` and `exec.run("glab", ...)` are checked like `exec.git`,
  because all of them start git.
  - Both get git's fixed environment and the ssh variables, and `glab` also has its
    prompts, update check, usage data, colour, pager and hyperlinks turned off
    (`GLAB_NO_PROMPT`, `GLAB_CHECK_UPDATE`, `GLAB_SEND_TELEMETRY` and the rest).
  - A tool that runs them does not make a git call of its own first.

### What the git check refuses

- **A program git would run:** `core.sshCommand`, `core.pager`, `core.editor`,
  `core.askPass`, `core.hooksPath`, `core.gitProxy`, `core.fsmonitor` (unless it
  is false), `credential.helper`, `diff.external`, `uploadpack.packObjectsHook`,
  `gpg.program`, `sequence.editor` and `protocol.allow`.
- **A program git would run, under any subsection:** `credential.<name>.helper`,
  `filter.<name>.clean`, `smudge` and `process`, `diff.<name>.textconv` and
  `command`, `merge.<name>.driver`, `gpg.<name>.program` and
  `protocol.<name>.allow`.
- **A redirect of a remote:** `url.<base>.insteadOf` and `pushInsteadOf`.
- **A file that adds more configuration:** `include.path` and
  `includeIf.<condition>.path`.

Names are compared without regard to case, as git does. Normal settings, such as
`remote.*`, `branch.*`, `user.*` and `core.bare`, pass. The check is read-only,
and its answer is kept until the configuration files change.
