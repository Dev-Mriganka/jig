# Events

What `jig-git` publishes on Pi's event bus, and what a listener can rely on. Back
to the [jig-git overview](../README.md).

## `jig-git:pushed`

Published after a push has landed, and after a pull request was created. It is
how `jig-git` tells the rest of Jig that there is a new head to look at, without
knowing who is looking.

```json
{ "repo": "acme/orders-api", "branch": "feature/orders-fix", "sha": "<40 hex digits>", "pr": 42 }
```

| Field | Meaning |
|---|---|
| `repo` | `owner/name`, as origin names it on GitHub; on GitLab the project's whole path |
| `branch` | The branch that was pushed |
| `sha` | The full id of the pushed head |
| `pr` | The open pull request or merge request of the branch. Left out when there is none |

- **A push publishes it once it has landed.** A push whose reply was lost is
  checked once with `ls-remote`, and published only if the remote has the commit.
  A push that was refused publishes nothing.
- **A new pull request publishes it again,** with `pr`. A listener that started a
  watch on the commit after the push can replace it with one on the pull request.
- **Nothing is published when origin is on neither GitHub nor GitLab,** because there is no
  project to name. The same goes for a pull request that was not created.
- **On GitLab `repo` is the whole path,** which may have groups, as in `platform/payments/orders-api`. `pr` is the number of the
  open merge request, asked of GitLab through `glab`; a lookup that fails leaves it out and never undoes the push. `jig-ops`
  matches `owner/name` only, so it does not start a CI watch for a project in a subgroup yet.
- **A listener that fails does not undo the push.** The result of the push does not
  depend on who reads the event, and the event carries no secret and no text from
  the model.
- **Anyone can publish on the bus,** so a listener checks the payload before it acts
  on it. `jig-ops` does.

`jig-ops` listens and starts a CI watch for a service of its catalog that has this
repository; see [Watching CI](../../jig-ops/docs/ci.md#watching-ci). `jig-git` does
not import it, read its files or know whether it is installed.
