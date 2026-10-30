# Not verified yet

What the tests of `jig-jira` do not cover. Back to the
[jig-jira overview](../README.md).

Written from Jira's documentation and a fake Jira on this machine. Not tried
against a real Jira:
- the exact shape of the answers of both editions: `search/jql` and `search`,
  the create screen (`createmeta`), users, and comments on long threads;
- that the sign-in forms work against a real single sign-on gateway or proxy;
- how the rendered page compares with Jira's own rendering of unusual markup;
- that a real sign-in proxy answers `GET /myself` with 403 or 404, or refuses it
  from its transport, as `comment` expects (the fake Jira and a fake transport do);
- a transition whose screen asks for a field (`resolution`, for example): the
  tool sends no field with a transition, and Jira's refusal is shown.
