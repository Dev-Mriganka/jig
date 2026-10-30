# Not verified yet

What the tests of `jig-api` do not cover. Back to the [jig-api overview](../README.md).

Written from the formats' documentation and a fake API on this machine, over plain `http` through `allowPlainLocal`. Not tried against
a real service:

- **Real exports.** The Postman fixtures are written to the v2.1 schema and the documentation of the environment export, and the
  `.http` fixtures to the JetBrains and VS Code documentation. They were not exported from Postman, IntelliJ or VS Code, so a
  detail those tools add (an old export's quirks, a dialect extension) may be read differently. A file the tool cannot read is a
  problem with its file and key, not a crash.
- **How Postman writes WebSocket and gRPC requests** into a collection file. Such a request is refused by its address scheme, its
  method or a protocol profile that names a protocol; a form this does not recognise would be refused later, as an address that is not
  http(s).
- TLS to a real host, including a company certificate authority;
- a real OAuth server: whether it takes the client's id and secret as Basic credentials, and the shape of its errors;
- a real sign-in service and transport, which are company code;
- host names that point at a blocked address: names are not looked up (see [Safety](safety.md#addresses-that-are-never-called));
- the review screen: the preview was checked as data, against a fake of `jig-core`, and not seen in the terminal;
- large collections: reading is done on every call, and was only tried on fixtures of a few dozen requests.
