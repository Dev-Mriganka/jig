# Not verified yet

What the tests of `jig-logs` do not cover. Back to the
[jig-logs overview](../README.md).

The tests run against a fake search server on 127.0.0.1 and a fake transport.
Nothing has been tried against a real OpenSearch or Elasticsearch:
- **A real OpenSearch or Elasticsearch.** The request bodies follow the search
  API and an earlier harness that ran them against OpenSearch, but these parts
  are new and have never run against a real backend: the `format` on the time
  range, `analyze_wildcard` on a Lucene query, the 25 second search timeout, the
  check for data as a `size: 0` search (the earlier harness used a count),
  fields named in the configuration, and the `term` filter.
- **Each kind of `auth` against a real server,** and TLS with a certificate
  authority of its own.
- **Masking of the lines.** A line is cut so that no JSON body or quoted value is
  left open, because `jig-core` withholds a line it cannot read. A random test
  outside this plugin cut about 41 000 lines of nested JSON, escaped JSON and
  `key="value"` text, and `jig-core`'s masker withheld none of them; cutting the
  same messages with a plain slice made it withhold them at once. The test suite
  does not run it, because a plugin reaches `jig-core` only through its contract.
- **What `jig-core` does when classifying throws.** An unknown environment throws
  a `TypeError` from the declaration. `jig-core`'s gate blocks a call whose
  classification throws with "jig-core could not decide: ..." and records it as
  `internal`; `invalid` is the record kind for a preview that throws. The message
  the model reads names the environments that exist. This was read in
  `jig-core`'s code and tested with a fake, not run in a session. `execute`
  refuses the same call the same way.
