# Watching CI until it is done

How `jig-git` watches GitHub in the background, and when a watch is done. Back
to the [jig-git overview](../README.md), which has the picture of a push
leading to a wake-up.

A watch runs on `jig-core`'s watch engine, outside the sandbox, and the call
that starts it returns at once. `jig-git` supplies what to poll on GitHub and
when the watch is done.

1. **It starts by itself** after `git push` and `pr create` (setting
   `watch.auto`), or when the agent calls `checks watch`. A newer push to the
   same branch replaces the watch of the older commit. Its title says what it
   watches, such as "checks of pull request 42" or "checks of branch x at
   abc1234".
2. **Its finish line is explicit, never "all checks".** It can be:
   - the required checks;
   - a named check, such as the job that builds the image;
   - one run;
   - a pull request state, such as approved or merged;
   - a bot comment matching a pattern;
   - a tag or release matching a pattern.

   It stops at the first required failure. It sends a "still waiting" notice
   after 30 minutes and gives up after 60, unless `watch.stallMinutes` and
   `watch.timeoutMinutes` say otherwise.
3. **It polls GitHub's API every 30 seconds (`watch.pollSeconds`), with
   ETags.** An unchanged answer (`304`) does not count against GitHub's rate
   limit, and the watch follows GitHub's `X-Poll-Interval` when GitHub sends
   one. A lost login gives one notice and pauses the watch; it never blocks a
   call.
4. **It sends one message per result, and the message starts a turn of the
   agent.**
   - When the watch passes: counts and the commit.
   - When it fails: the failing checks, their links, and the lines around the
     first error in the failed job's log.

   Notices are combined when they arrive together, sent at least 10 seconds
   apart, and only one waits at a time.
5. **Open watches survive a restart.** They are saved in the state folder and
   resume when Pi starts. A result found by the first poll after a restart
   begins "While Pi was closed: ".

## What each finish line means

| Finish | The watch ends when |
|---|---|
| Required checks (the default) | Every required check passed, or at the first required failure. A required check that no one has reported yet is pending |
| A named check | That check ends. Passed is a pass. Failed, cancelled, timed out or skipped is a failure: a skipped check will never run |
| One run | The run completes, or one of its jobs fails |
| A pull request state | Approved: someone approved and nobody asks for changes. Merged: the pull request is merged. Either way, a pull request closed without a merge is a failure, and a request for changes while waiting for approval is a failure |
| A bot comment | A comment made after the watch began matches the pattern. By the named login, else by any bot |
| A tag or release | A tag or release that did not exist when the watch began matches the pattern, or a tag on the watched commit does |

The required checks come from the protection and the rulesets of the pull
request's base branch, or of the default branch when there is no pull request.
When neither names a check, every check counts. A pull request that gets a
newer commit ends the watch of the older one as stopped.

## Events

On Pi's event bus, for other plugins:
- `jig:watch-done`, from `jig-core`'s engine: a watch finished, with its
  result;
- `jig-git:artifact-ready`:
  `{ repo, pr, sha, kind: image | tag | release, ref, source: check | log | comment | tag | release }`.
  `ref` is the version, tag or release tag. For a rule with a job and no log
  pattern, it is the short commit id.
