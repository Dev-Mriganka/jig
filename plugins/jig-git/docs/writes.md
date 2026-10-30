# Writes: previews, and lost replies

What you see before a write to GitHub asks, and what the tools do when a reply
is lost. Back to the [jig-git overview](../README.md).

## What you see before a write asks

| Action | The preview |
|---|---|
| `git push` | The branch, the remote, the head commit and the commits to send |
| `git restore` | The paths, and a diff stat of what would be lost |
| `pr create`, `edit`, `comment`, `reply`, `review` | The text, rendered, on the review screen |
| `pr merge` | The title, the method and the head commit |
| `checks rerun` | The run, and whether all jobs or only the failed ones run again |
| `release` `tag_push`, `release_create` | The tag and what it points at, and the notes |

Each preview carries a digest of what it shows. When the call runs, the tool
works out what it would do now. If the digest differs, it refuses with
"changed since the preview; run it again to see the new preview". A new
commit, or a pull request head that moved while you read, is caught this way.
A call that did not ask has no preview to compare.

A call with the wrong parameters is refused with the usage line before it asks
anything.

## When a reply is lost

A write to GitHub can time out, lose its connection, get a gateway error, or be
cancelled with Esc after the request left. Then the tool:
- reads GitHub once, to see whether the change is there;
- reports what it found, and that the reply was lost;
- never sends the request again.

The one read is `pr list` for a new pull request, `pr view` for an edit, a
merge, a draft or a review, the thread itself for a reply or a resolve,
`ls-remote` for a push or a tag, the run's attempt number for a rerun, and
`release view` for a release.
