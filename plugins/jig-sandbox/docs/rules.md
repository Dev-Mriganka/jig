# The rules

Every path `jig-sandbox` treats specially, and why. Everything not listed here is
writable inside the sandbox, as it is outside. Back to the [jig-sandbox overview](../README.md).

Paths are matched where they really are, through symbolic links, and only when they
exist: a rule for a path that is not on this machine adds nothing to the sandbox.

## Hidden: never readable

The first group is the same list `jig-core` protects from Pi's file tools, so the two
cannot disagree. A company plugin's additions to that list apply here too.

**Credential stores and logins**
- `~/.ssh`, `~/.gnupg`, `~/.password-store`
- `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`
- `~/.config/gh`, `~/.config/glab-cli`, `~/.config/github-copilot`
- `~/.netrc`, `~/.git-credentials`, `~/.config/git/credentials`
- `~/.docker/config.json`, `~/.vault-token`, `~/.terraform.d/credentials.tfrc.json`
- `~/.config/op`, `~/.config/1password`, `~/.config/rclone`
- `~/.pgpass`, `~/.my.cnf`, `~/.postman`, `~/.flyrc`
- Pi's `auth.json` and `mcp-auth.json`; other agents' `~/.claude/.credentials.json`,
  `~/.codex/auth.json`

**Build and package credentials**
- `~/.gradle/gradle.properties`, `~/.m2/settings.xml`, `~/.m2/settings-security.xml`
- `~/.npmrc`, `~/.yarnrc`, `~/.yarnrc.yml`, `~/.pypirc`, `~/.cargo/credentials`,
  `~/.cargo/credentials.toml`, `~/.gem/credentials`

**A project's secret files**, in the working folder and the repositories one and two
levels below it:
- `.env`, `.env.local`, `.env.production` and every other `.env.*`, except templates
  (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`);
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`.

A secret file the agent creates itself during the session is its own and is not
hidden.

**Doors to other systems**
- On WSL: `/mnt` (the Windows drives, where Windows-side tokens live) and `/run/WSL`
  (running a Windows program from here would run it outside the sandbox). Two
  exceptions: `/mnt/wsl/resolv.conf` stays readable, because `/etc/resolv.conf` points
  at it and without it no name resolves; and folders you `share`.
- Agent and desktop sockets: `/run/user/<you>` (the session bus and the desktop
  keyring), `/tmp/ssh-*` (the SSH agent), the GPG agent's sockets.
- The Docker socket (`/var/run/docker.sock`, `/run/docker.sock`), unless `docker: true`.

## Locked: readable, never written

Each of these runs later outside the sandbox, so a write there would carry a command
out of it.

**Shells and login**
- `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.bash_logout`, `~/.bash_aliases`,
  `~/.profile`, `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.zlogin`, `~/.zlogout`,
  `~/.config/fish`
- `~/.config/systemd/user`, `~/.config/autostart`, `~/.config/environment.d`,
  `~/.xprofile`, `~/.xinitrc`, `~/.xsessionrc`, `~/.tmux.conf`, `~/.config/tmux`

**Programs that run outside**
- Every folder on `PATH` that is not a toolchain manager (those ask first, below)
- The Node.js and Pi installs that run Pi
- `~/.gitconfig`, `~/.config/git`

**Pi, Jig and other agents**
- Pi's agent folder (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`): settings, extensions,
  `jig.json`, every `jig-*` state folder
- In the project and every folder above it below your home: `.pi/settings.json`,
  `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/mcp.json`, `.agents`.
  `.pi/docs` and other files under `.pi` stay writable.
- `~/.agents`; Claude Code's `settings.json` and `settings.local.json`, in your home
  and the project (their hooks run with no sandbox)

**Repositories** (the working folder and the repositories one and two levels below)
- `.git/hooks`, and `core.hooksPath` folders a repository names
- `.git/config` is **not** locked: see [Git configuration](when-blocked.md#git-configuration)

**Build tools**
- `~/.gradle/init.gradle`, `~/.gradle/init.gradle.kts`, `~/.gradle/init.d` (run by every
  Gradle build)
- `~/.m2/extensions.xml`, `.mvn/extensions.xml` and `.mvn/jvm.config` in a repository
- `~/.cargo/config.toml`, `~/.cargo/config` (can name a program to wrap the compiler)
- `~/.config/pip/pip.conf`, `~/.pip/pip.conf` (can point installs at another index)
- `~/.npm-global/bin` and npm's global prefix, when it is in your home

**IDE settings that start programs**
- In the project: `.vscode/tasks.json`, `.vscode/settings.json`, `.idea/workspace.xml`,
  `.idea/runConfigurations`
- Python start-up hooks: `*.pth` files in your user site-packages

## Ask first: writable once you say yes

Toolchain managers put programs on your `PATH`, so a write there can run outside the
sandbox later. Installing a JDK or a Node version is still a normal thing for the agent
to do, so these ask instead of refusing:

- `~/.sdkman`, `~/.nvm`, `~/.pyenv`, `~/.rbenv`, `~/.rustup`, `~/.cargo/bin`, `~/.asdf`,
  `~/.local/share/mise`, `~/.volta`, `~/.bun`, `~/.deno`, `~/go/bin`

The question names the folder and says why it matters. Your answer counts for this
session, or always (kept in Pi's agent folder, listed by `/sandbox allowed`).

## Writable: everything else

Your home folder, the project and its siblings, `/tmp`, and every cache a build uses:
`~/.gradle/caches`, `~/.gradle/wrapper`, `~/.m2/repository`, `~/.npm`, `~/.cache`,
`~/.local/share/pnpm`, `~/go/pkg/mod`. Builds run as they do outside.

One risk stays, on purpose: a command could change a downloaded file in a cache that
a later build outside the sandbox uses. Closing it means separate caches: every
dependency downloaded again, and no way to reach a private repository, whose
credentials stay hidden. It is listed under [Later](../README.md#later), with the
stand-in credentials that would let separate caches reach private repositories.

## Your additions

`hide` and `lock` in the `sandbox` section add paths, and `share` makes a path
writable although a rule says otherwise, for example a Windows work folder:

```json
{
  "sandbox": {
    "share": ["/mnt/c/Users/me/work"],
    "hide": ["~/private-notes"],
    "lock": ["~/bin/deploy.sh"]
  }
}
```

`share` cannot open a hidden credential path: those are the floor.
