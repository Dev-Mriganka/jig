# Artifacts, and why jig-git never deploys

How `jig-git` knows that a build or a tag exists, and what it leaves to a
company plugin. Back to the [jig-git overview](../README.md). The event that
announces an artifact is described under [Events](watching-ci.md#events).

## Knowing that a build or a tag exists

Rules in configuration say when an artifact is ready. They are tested when a
watch has passed:
- a named job succeeded for the head commit;
- a version is read from that job's log, by a pattern, and it contains the
  head's short commit id;
- a bot comment on the pull request matches a pattern;
- a tag or release matches a pattern, and it is on the head commit or carries
  its short id.

A version that does not contain the watched commit is ignored. A rule that
cannot be tested (the log has expired, say) does not lose the watch's result:
the message says so.

## `jig-git` never deploys

What happens after "artifact ready" is a company decision. A company plugin may
listen for the event, and it always tells the agent. It may start a deploy by
itself only when all of these hold:
- its automatic deploy setting is on (off by default);
- the watch was started for a deploy you asked for;
- the target is `staging`, the only place an automatic deploy may go, by
  policy, and the deploy replaces no one else's build there.

The deploy goes through `ctx.executeTool`, so `jig-core` still decides:
- a write to a test environment asks, unless your rule allows it;
- production is denied, and is never automatic.

Automation stops wherever a person must approve, such as a pull request that
needs a code owner.
