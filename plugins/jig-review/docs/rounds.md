# Rounds

How a review goes from your comment to the agent's answer to the next diff, and what it leaves behind.
Back to the [jig-review overview](../README.md).

## A round

1. **A review opens.** `/code-review`, the agent's start tool, or an offer after the agent changed files.
   The record gets its first iteration: the diff as it is now.
2. **You comment.** A draft is yours alone until you send it. **Ask** sends one comment now; **Finish
   review** sends every draft and the general comment together.
   - Either way the review moves to `awaiting-agent`.
   - The comments reach the agent as a follow-up message, as if you typed them: the location
     (`orders-api/Service.java:12 new`), the comment, and the commits the review was made against.
3. **The agent answers.** For each comment it makes the change or explains why not, then calls
   `record_interactive_review_resolution` with the comment ids, `fixed`, `answered` or `wont-fix`, a summary,
   a small unified diff in `beforeAfter`, and `addressedLocations` for the changed lines. The page shows the
   agent's note on those lines.
4. **The next round.** When the agent's turn ends, the review gets a new iteration with the cumulative
   diff, and Pi asks whether to reopen the page (after **Ask**, it does not ask). The review is
   `awaiting-review` again.
5. **You approve,** or comment again. A review waiting for the agent cannot be approved.

## What a review leaves behind

One JSON file per review, in `<agent folder>/jig-review/workspaces/<name>-<hash>/reviews/`, mode 0600:

| Field | Meaning |
|---|---|
| `id`, `status` | the second it was made; `awaiting-review`, `awaiting-agent`, `approved` or `abandoned` |
| `fileScope`, `folder`, `ticket` | what it covers |
| `iterations` | each round's diff and its hash, and which comments and resolutions it holds |
| `comments`, `resolutions` | what you said, and how the agent answered each |
| `pageApprovedAt` | Approve was pressed without a passkey and Pi has not answered. Cleared by a `n` |
| `approval` | `{ method: "passkey" \| "page-and-pi", at, fingerprint? }`, present exactly when approved |
| `approvedHeads` | the full commit of each reviewed repository, only when the approved diff was still the current one |

A **branch** review vouches for commits: the diff you approved is hashed against the current one, and
only if they match does the record hold `approvedHeads`.

A review of uncommitted or touched files never does, because the branch's earlier commits were not in it. A workflow gate that
wants "the push is covered by an approved review of that commit" reads `approvedHeads`.

## The event

On approval the plugin emits `jig-review:approved` on `pi.events`:

```json
{ "reviewId": "2026-10-30T10-00-00Z", "scope": "branch", "ticket": "PROJ-123",
  "repos": [{ "repo": "orders-api", "head": "…40 hex…", "root": "/work/orders-api" }], "covered": true,
  "files": ["orders-api/Service.java"], "method": "passkey" }
```

- **`repos`** lists every reviewed repository and where it stood. `repo` is its path from Pi's folder, which two
  repositories outside that folder can share; `root` is its own folder, absolute, for a listener that must tell them apart.
  It is left out when the folders cannot be worked out.
- **`covered`** says whether the approval vouches for those commits (a branch review whose diff was still the one you saw).
- **`jig-workflow`'s `review-done`** listens for it, and keeps only a `covered` approval of a bound repository. Anyone can publish on the bus, so a listener checks the payload, and a
  gate that must not be forged should read the record, which only this plugin writes.

## Telling the agent

When the agent opened the review with its start tool and it is still the current one, approval sends the
agent a message with two things:
- **How it was approved:** `with a passkey, which the user's device verified`, or `in the page and then with a y in Pi`.
- **What it covers:** exact commits, nothing (the code changed after you looked, so it must not push), or only the latest changes.

A review from the offer, or from your own `/code-review`, sends nothing: the agent is not waiting on it, and a message would
restart what it was doing.

## Cleanup

Every Pi started in a folder shares its reviews. When an interactive session starts, a pending review is
deleted (or kept as `abandoned` when it has comments) only if the Pi that made it has exited or it was last
touched over a day ago. A subagent child and `pi -p` never clean up, and loading the plugin writes
nothing.
