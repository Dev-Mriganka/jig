# Tests

How `workflow test` finds a repository's test command, runs it inside the sandbox, and records the result
against the exact commit. Back to the [jig-workflow overview](../README.md).

`tests-pass-at-head` is the condition that most often goes wrong when a model reports it: "the tests
pass" about a tree that is not the commit being pushed. So the agent does not report it. It asks for a run,
and the plugin records what happened.

## The command for a repository

For each bound repository, the first of these that applies:
1. An entry of `workflow.tests` in `jig.json` whose key matches the repository.
2. A default for the build file found in the repository's root.

A key matches when it equals the repository's folder name or the repository name in `origin`'s address
(a worktree is often called `orders-api-PROJ-123` while the repository is `orders-api`), or when, as a
pattern (`*` for any run of characters except `/`, `**` for any), it matches the path relative to Pi's
folder or the absolute path. Keys are tried in the order they are written.

A value is a command, or `{ "command": "...", "timeoutSeconds": 300 }`. The default timeout is
`workflow.testTimeoutSeconds`, 900. Nothing is shell-expanded by the plugin; the command is run by the
shell, in the repository's root.

| Found in the root | Default command |
|---|---|
| `gradlew` | `./gradlew test` |
| `build.gradle` or `build.gradle.kts` | `gradle test` |
| `pom.xml` | `mvn -q test` |
| `package.json` with a `test` script | `npm test` |
| `pyproject.toml`, `pytest.ini`, `tox.ini` or `setup.py` | `pytest` |
| `go.mod` | `go test ./...` |
| `Cargo.toml` | `cargo test` |

The first row that is found wins. With no entry and no build file, `workflow test` fails for that
repository and says to set `workflow.tests`.

## Variables for a repository

A repository may need its own environment, such as a JDK of the right version. Give the object form of the entry an `env`:

```json
{
  "workflow": {
    "tests": {
      "orders-api": { "command": "./gradlew test", "env": { "JAVA_HOME": "~/.sdkman/candidates/java/17.0.9-tem" } }
    }
  }
}
```

- **Names and values.** A name is capital letters, digits and `_`, and not a digit first. A value is text without a NUL
  character, at most 1000 characters. At most 20 variables.
- **No credentials.** A name that looks like one is refused, with the key named: the same patterns `jig-sandbox` takes out
  of a command's environment (`TOKEN`, `SECRET`, `PASSWORD`, `_KEY`, `AWS_`, `GITHUB_`, ...). Credentials belong in a
  secret reference, not in this file.
- **`~` is your home folder,** at the start of a value and after a `:` in a list such as `PATH`. Nothing else is
  expanded: `$HOME` stays the text `$HOME`.
- **They apply wherever the command runs.** In the sandbox they are set by the command line (`export JAVA_HOME=... &&
  ./gradlew test`), because the sandbox takes a command and nothing more; the values are quoted, so the shell reads each
  as text. Outside it, the shell gets them in its environment.
- **The question shows them.** When a run needs your approval, each command is listed with its variables. The record
  keeps the command as you configured it.

## Where the command runs

- **In the sandbox, when `jig-sandbox` is active.** `workflow test` calls `jig().sandbox.run`, which
  `jig-sandbox` implements with its normal wrapping: the same rules, environment, audit and explanations
  as the agent's `bash`, with a timeout. A test that needs a hidden credential or a locked path fails with the
  sandbox's usual explanation in the output the tool returns. Your network mode applies.
- **Otherwise, outside it, and only after you approve.** With no sandbox, a sandbox that is switched off,
  or one that cannot run commands, the call always asks. The question lists each command, its folder and
  the timeout, and says that the commands run as you, with your credentials and the network. The run is
  `/bin/sh -c`, through `jig-core`'s `exec`, which gives it a short environment (no tokens). The result
  is recorded as `sandboxed: false`, and `status` says so.
- **Never silently outside.** If the call was let through because a sandbox was there and it has gone by the
  time the tool runs, the tool stops and says so; it does not fall back to the unsandboxed run, which would
  need your yes.

## What is recorded

One result per repository, replaced by the next run, in `workflow.json`:

| Field | Meaning |
|---|---|
| `head` | The full commit HEAD was at when the run began |
| `clean` | Whether the tree had no changes, tracked or untracked, then |
| `passed` | The command exited 0 and did not time out |
| `command`, `exitCode`, `timedOut` | What ran, and how it ended |
| `sandboxed` | Whether it ran in the sandbox |
| `at`, `durationMs` | When, and how long |

The output is not saved. The tool's result carries the last 60 lines, cleaned and capped like any result,
for the agent to read; the full output is the sandbox's, or the program's, to keep.

## When a result stops counting

`tests-pass-at-head` holds for a repository when the result passed, was clean, and its `head` is the HEAD
now. So:
- **A new commit invalidates it,** and so does a checkout of another commit. The next push is held until
  `workflow test` runs again.
- **A run on a dirty tree is recorded** and shown, but never satisfies the condition: it tested files that
  are not the commit. Commit, then run again.
- **Changes after a clean run** do not undo it. A push sends commits, and HEAD is what was tested;
  `status` tells you the tree has changes.

## Order, cancelling and failures

- The repositories run one after another, each result saved as soon as it ends, so a cancelled run keeps
  the ones that finished.
- Cancelling the call stops the command; a result is not recorded for a run that was cancelled.
- A command that cannot start, a timeout, a sandbox that refuses (it could not start) and a missing test
  command each fail that repository with their reason and go on to the next.
- `repo` limits the run to one bound repository.

[Back to the overview](../README.md)
