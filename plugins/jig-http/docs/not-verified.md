# Not verified yet

What the tests of `jig-http` do not cover. Back to the
[jig-http overview](../README.md).

Written from the standards and a fake API on this machine, over plain `http`
through `allowPlainLocal`. Not tried against a real service:
- TLS to a real host, including a company certificate authority;
- a real OAuth server: whether it takes the client's id and secret as Basic
  credentials, and the shape of its errors;
- a real sign-in service and transport, which are company code;
- the review screen: the preview was checked as data, against a fake of
  `jig-core`, and not seen in the terminal.
