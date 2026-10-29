# Jig agent guide

This repository is design only for now. Plugin READMEs are the
specifications. Code follows them, and when either changes, the other changes in
the same commit.

- **Read first:** [docs/architecture.md](docs/architecture.md) and
  [docs/permissions.md](docs/permissions.md).
- **Generic only.** Nothing company-specific goes here: no company names,
  internal system names, environment names or hostnames. Those belong in a
  private company plugin.
- **The existing harness is reference only.** Read it to port from; never
  modify it.
- **The floor in [Permissions](docs/permissions.md) is not configurable.** Do
  not add settings that lower it.
- **Approvals happen inside the waiting tool call.** Never add a web endpoint
  that approves.
- **Git:** clear commit messages, no `Co-Authored-By` lines. Push only when
  asked.
