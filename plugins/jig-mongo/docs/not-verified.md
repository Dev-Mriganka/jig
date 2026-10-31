# Not verified yet

What the tests of `jig-mongo` do not cover. Back to the [jig-mongo overview](../README.md).

The tests use these fakes:
- a fake of the driver seam (what the tool asks of the database, recorded);
- a fake of the driver's client (what `driver.ts` asks of the driver);
- a fake `ssh` on `PATH`;
- a SOCKS5 server and servers that speak a little of the wire protocol, for the proxy route.

No test connects to a MongoDB unless `JIG_TEST_MONGO_URI` is set (see `test/integration.test.ts`; give it a user and password in the
address to run the tool itself as well). It was run once, on one machine, against a single MongoDB 8.0 node with authentication on
and no TLS, started for the purpose. Not tried:

- **A server that is not that one.** A managed service (Atlas, DocumentDB and the like), a replica set (the secondary read preference of
  production), a sharded cluster, an older server, TLS, and a user with fewer privileges than the one the test signs in as.
- **The shapes of `explain`.** The plan summary was written from the documented shapes of a find, an aggregation and the slot-based
  engine, and tried on examples of them, not on output from a server.
- **The index check.** It was run against one MongoDB 8.0 node: a find, the pipeline that counts, an aggregation with a `$group` first,
  a `$unionWith`, and a `$lookup` that the planner reports as a `HashJoin` and one that it does not report at all.
  - Not tried: a sharded cluster (a plan per shard is read from the documented shape), a server older than 6.0, Atlas, DocumentDB
    (its `explain` differs), and a user who may run a find but not `explain`.
  - A `$lookup` written only as a sub-pipeline is checked only where the planner reports its plan. This 8.0 node did not report one in the case tried.
  - A `$sample` with no filter is not checked, because it reads a bounded number of documents. On a small collection the server
    scans it to sample.
- **`$collStats` and `$indexStats`** on a managed service: they need privileges a read-only user may lack, and a view has no storage
  statistics. The error is reported, not hidden.
- **A `$lookup` without a pipeline in an allow list** is given one for the projection, which needs MongoDB 5.0. On an older server the
  call fails with the server's error.
- **Time series, views and sharded clusters:** `collections` shows their types; nothing else was tried on them.
- **TLS to a real host,** including a company certificate authority, and certificate checking of a forwarded connection through the
  `servername` option.
- **The SSH route against a real bastion:** the arguments and the key file were checked against a fake `ssh`. Real `ssh` versions differ in
  what they print on failure, so a failure that matches none of the patterns is reported as a general failure with its exit code.
- **A company tunnel:** the forward and the SOCKS kinds were tried with a fake provider. For SOCKS the test uses a SOCKS5 server
  written for it, the real driver and the `socks` package, and small servers that speak enough of the wire protocol to answer a
  replica set's handshake. Not tried: a real jump host, a real SOCKS proxy, and a `mongodb+srv` address (its DNS lookup is local).
- **The review screen:** the preview was checked as data against a fake of `jig-core`, and not seen in the terminal.
- **How masking treats a result:** production results are masked by `jig-core`'s backstop. That the Extended JSON lines are masked field
  by field was not run against the real masker.
- **Large results:** the output limit was tried with documents of tens of kilobytes, not with a real cursor of thousands.

## Facts the code relies on

- The driver's relaxed Extended JSON writes a 64-bit integer as a number, which loses digits beyond 2^53, so `bson.ts` writes `$numberLong` itself.
  - *Source:* tried against the driver's `Long`.
- Converting an object that has `$regex` to BSON drops its other operators, so `driver.ts` converts typed values one at a time.
  - *Source:* tried against `EJSON.deserialize`.
- A listener that was just closed can go on accepting connections for a few milliseconds, so a free port is handed out only once it refuses.
  - *Source:* seen on WSL2.
- `servername` and `checkServerIdentity` are accepted as client options.
  - *Source:* the driver's `connection_string.js`.
- `retryWrites: false` is what stops the driver from sending a write again.
  - *Source:* the driver's documentation of retryable writes.
