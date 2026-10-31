# Not verified

What the tests of `jig-agents` do not show, because only a real model, a real terminal or another
platform can. Back to the [jig-agents overview](../README.md).

Everything here was run against the fake child, or against the stock Pi 1.4 on Pi's own scripted model,
on Linux. No model was called.

## Needs a real model

- **That a model delegates well.** The tool's description and the skill say when to start a scout or a
  reviewer. Whether a real parent agent starts one at the right time, writes a task a child can act on,
  and treats the report as data is not measured. The earlier harness measured that its agent delegated
  only when asked.
- **That a model obeys the wrap-up.** At a limit the child is steered to write its report and given two
  more turns. The scripted model never writes one, so the tests see the abort, not a report written in
  time. Whether a real model does is not known.
- **That a report puts the answer first.** The shipped roles ask for it; the message shows only the first
  10 lines.
- **That preloading a skill makes a model use it,** and that a scout with fewer skills does better. The
  tests show that the text is in the child's instructions and that the other skills are not listed; they
  cannot show what a model does with either. The same holds for `thinking`: the flag reaches Pi, which clamps it
  to the model, but a scripted model has no thinking to change.
- **Cost against a real price.** The cost limit is tested with the fake child's numbers. Pi's faux
  provider reports a cost of zero, so the real Pi runs show "cost unknown". A priced model counting
  against `maxCost` through `get_session_stats` is read from Pi's documents and not run.

## Needs another part of the stack

- **`bash` in `jig-sandbox` against the child's input.** The first defence is tested: the child's pipes are
  sockets that `/proc/<pid>/fd` cannot reopen, and a request's id is random and never reaches the model.
  Whether a sandboxed `bash` has any other way to the child Pi's memory or descriptors, such as `ptrace`
  where `ptrace_scope` is 0, is not tried: the real-Pi tests load `jig-core` and `jig-agents` only.
- **`jig-sandbox` in a child.** The check that a child lists `/sandbox` when the parent does is tested with
  a stand-in command. A child that loads the real sandbox, and the cost of its broker once per child, is not.
  A read-only `bash` is tried in a real Pi child that loads `jig-sandbox` and runs a real command, which reads, writes
  `/tmp` and fails to write its working folder. What is not tried is the cost of a broker for every child, or a
  scout running `rg` and `git log` on a large repository.
- **Skills as a plugin lists them.** The parent learns a child's possible skills from `pi.getCommands()` and reads
  `metadata` from their files, because Pi gives an extension nothing else. This is tested on Pi 1.4; a later Pi
  that lists skills differently would show a role every skill or none.
- **A real terminal.** Questions are shown through a fake screen that closes a question when its signal
  fires, as Pi's does. How Pi's terminal interface draws a title of 31 lines, and how a user feels
  about answering three children's questions in a row, is not seen.
- **A parent that is itself an RPC host.** Its own host would be asked the question. The plugin calls
  `ctx.ui.select`, which Pi turns into a request; no host was put there.
- **Two children and one tunnel.** Whether two children opening the same `jig-core` tunnel clash is not known.
- **Secrets that prompt.** A child has no terminal, so a secret backend that asks for a passphrase would
  hang. Working with an already unlocked backend is assumed.

## Needs another platform

- **macOS.** The identity of a process, which keeps the sweep from touching a reused process id, is read
  from `/proc` on Linux and from `ps -o lstart=` elsewhere. The second is not run.
- **Windows.** Process groups do not exist there, so a child's descendants are not ended with it. The
  plugin is not meant for Windows; `jig-sandbox` does not support it either.

## Open choices

- **Unpriced models.** Whether to cap by tokens instead is open. Only turns and minutes bound a child
  whose model has no price.
- **Holds do not reach a child.** A child's session has no active ticket, so `jig-workflow`'s holds do not
  apply inside it. A workflow file can hold `subagent start` itself, such as until the plan is approved.
- **A tool that classifies a write as a read.** A read-only role's gate trusts `jig-core`'s classification of each
  call, as everything in Jig does. A tool that declares an action a read when it writes is not caught by `writes:
  false`; `actions` is the second line, because it names the allowed actions. `scout` and `reviewer` list the
  read actions of `git` and no other, and a test checks them against `jig-git`'s own table.

Back to the [jig-agents overview](../README.md).
