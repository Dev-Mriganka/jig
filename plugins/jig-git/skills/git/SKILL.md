---
name: git
description: How to work with the git, pr, checks and release tools - branch, commit, push, open and review pull requests, and wait for CI without polling. Use for any change that ends in a pull request, and whenever you would reach for git, gh or a CI page.
---

# Git, pull requests and CI

Use the `git`, `pr`, `checks` and `release` tools instead of `bash` for git and GitHub. The shell has no GitHub
sign-in and cannot push. Reads and local changes run at once. Anything that changes GitHub asks the user first, and the
user sees what it will send.

## The order of work

1. **Look first.** `git status` shows the branch, how far it is from its upstream and from the base, and the changed
   files. Without `repo` it covers every repository in the workspace; Pi started inside a repository means that one.
2. **Start from the fetched base.** `git branch` with `operation: create` fetches the base and cuts the new branch from
   it. It refuses when tracked files have uncommitted changes. If `git.branchName` is set, the name must match it.
3. **Commit exact paths.** `git commit` takes the files and a message. Other staged and unstaged work stays as it is.
   If `git.commitMessage` is set, the message must match it. `amend: true` replaces the last commit, and only while no
   remote has it; with no paths it only rewords.
4. **Push.** `git push` shows the commits it will send and waits for the user. It refuses the protected branches (by
   default the repository's default branch), and `force_with_lease` is the only force there is. If you commit again
   while the user is reading, the push refuses and says so; run it again to see the new preview.
5. **Open the pull request.** `pr create` needs the branch pushed at its tip. Leave `body` out to be shown the
   template; fill it in and call again. If a pull request is open for the branch, you get it back and nothing is
   created.

## After a push, do not poll

A push and a new pull request each start a background watch on the required checks of the pushed commit. It reports
once: when they all pass, or at the first required failure with the failing checks, their links and the lines around
the error in the log. The message starts your next turn. Do not call `checks status` in a loop.

Start a watch yourself with `checks watch` when the finish line is something else. Name it, never "all checks":
`check` for one job (the one that builds the image), `run_id` for a run, `finish: approved` or `merged` for a pull
request, `finish: comment` for a bot comment matching `pattern`, `finish: tag` or `release` for a new one matching
`pattern`. The `watch` tool lists and stops watches.

When a check fails and you need more, `checks log` gives the failed job's log: the tail, or only the lines matching
`grep`, at most 400 lines. `checks rerun` runs the failed jobs again and asks first.

## Review

- `pr comments` shows the conversation, the reviews and every line comment with its thread id. Filter with `author` or
  `unresolved`.
- `pr reply` answers in a thread and `pr resolve` closes it. Resolve a thread only after you fixed what it asks.
- `pr review` sends a comment or requests changes. You cannot approve a pull request: that stays with a person.
- `pr merge` merges only while the head is still the commit the user saw. `auto` turns on auto-merge instead.

## When a reply is lost

A write that times out or loses its connection may still have gone through. The tool then checks once and tells you
what GitHub shows. It never sends the request again. Do not repeat the call yourself until you have read the result.

## What is not offered

Deleting or moving tags, `reset --hard`, `clean`, approving a pull request and starting a workflow by hand. They destroy
work or decide for a person. If one is truly needed, ask the user to run it.

## Tags and releases

`release tag_create` makes an annotated tag locally. `tag_push` and `release_create` ask. A tag that is already on the
remote is never forced. Deploying is not done here: a tag or a build being ready is announced for other tools to act on.
