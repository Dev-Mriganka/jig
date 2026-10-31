# Not verified yet

What the tests of `jig-mongo` do not cover. Back to the [jig-mongo overview](../README.md).

The tests in `test/` use these fakes:
- a fake of the driver seam (what the tool asks of the database, recorded);
- a fake of the driver's client (what `driver.ts` asks of the driver);
- a fake `ssh` on `PATH`;
- a SOCKS5 server and servers that speak a little of the wire protocol, for the proxy route.

The tests in `test/it/` run the same code against a real MongoDB and a real SSH server, in the `integration` job of CI (see
[Integration tests](../../../docs/integration-tests.md)). One more test, `test/integration.test.ts`, runs the driver seam alone
against a server of your own when `JIG_TEST_MONGO_URI` is set.

## Verified in CI

A three-member MongoDB replica set with authentication (9.0 in one run, 8.0 in the other), and an OpenSSH 10.3 server on the same
Docker network. The members are
named `mongo1` to `mongo3`, which only that network can look up, so the routes are the only way to them.

| What | Proved by |
|---|---|
| Every action through the tool and the driver, with what a write did read back by a client of the test's own | `mongo.test.ts` |
| Typed values both ways: a decimal, a 64-bit integer beyond 2^53, a date and an ObjectId | `mongo.test.ts` |
| A find with and without an index in `explain`; `stats`; `indexes`; `index-stats` and its Unauthorized message for a user that only reads | `mongo.test.ts` |
| Views and time series in `collections` | `mongo.test.ts` |
| A preview with its count and fingerprint, "changed since the preview", the guards on an empty filter and on the cap | `mongo.test.ts` |
| A duplicate key from `insert` as the server's rejection (it was reported as a lost reply: fixed) | `mongo.test.ts` |
| The deny list, the allow list, a `$lookup` cut to the allowed fields on the server, `$getField` and `$unionWith` refused | `mongo.test.ts` |
| The index check of production on the real planner: reads an index serves are allowed (a filter, a count, a `$group` after an indexed `$match`, a sort with a limit); a `COLLSCAN` is refused with the fields that lead an index; a find or count with no filter is refused; `requireIndex: false` and a test environment run the same read; a reference collection is read whole | `mongo.test.ts` |
| Production lines through `jig-core`'s own masker | `mongo.test.ts` |
| A refused sign-in, a user without the right, and an address nobody answers | `mongo.test.ts` |
| The SSH route: the forward, the key file gone once ssh has signed in, and the forward ending with the session | `ssh.test.ts` |
| What real ssh says for an untrusted host key, a key the server refuses, a key it cannot load (it was told as refused: fixed) and a jump host nobody answers at | `ssh.test.ts` |
| A SOCKS tunnel from `ssh -D` to a replica set by the members' own names: reads, a write to the primary, a production read served by a secondary (counted on each member), and the index check asked of a secondary | `tunnel.test.ts` |
| This machine cannot look up the members, and the tool without a route fails | `tunnel.test.ts` |
| The tunnel ending with the session, and a tunnel that cannot open told in a line | `tunnel.test.ts` |

## What is still not verified

Not tried:

- **A server that is not those.** MongoDB 7.0 and older (CI ran 7.0 until it could start 8.x and 9.x: the members run with
  `GLIBC_TUNABLES=glibc.pthread.rseq=1`, which keeps `mongod` from refusing the runner's Linux kernel, see [MongoDB and the
  kernel](../../../docs/integration-tests.md#mongodb-and-the-kernel)), the rapid releases (8.1 to 8.3), a managed service (Atlas,
  DocumentDB and the like), a sharded cluster, and TLS.
- **The shapes of `explain`** beyond a find with and without an index: an aggregation, the slot-based engine and a sort. The plan summary was
  written from the documented shapes.
- **`$collStats` on a managed service,** and a view, which has no storage statistics.
- **A `$lookup` without a pipeline in an allow list** on a server older than 5.0.
- **Sharded time series.** `collections` shows a time series collection; nothing else was tried on one.
- **The index check** beyond what CI proves (see the table above, on MongoDB 9.0 and 8.0 replica sets). It was also run, before the CI test, against one
  MongoDB 8.0 node: a find, the pipeline that counts, an aggregation with a `$group` first, a `$unionWith`, and a `$lookup` that the planner
  reports as a `HashJoin` and one that it does not report at all.
  - Not tried: a sharded cluster (a plan per shard is read from the documented shape), a server older than 6.0, Atlas, DocumentDB
    (its `explain` differs), and a user who may run a find but not `explain`.
  - A `$lookup` written only as a sub-pipeline is checked only where the planner reports its plan. This 8.0 node did not report one in the case tried.
  - A `$sample` with no filter is not checked, because it reads a bounded number of documents. On a small collection the server
    scans it to sample.
- **TLS to a real host,** including a company certificate authority, and certificate checking of a forwarded connection through the
  `servername` option.
- **A `mongodb+srv` address.** Its DNS lookup is local, and the CI replica set has no SRV record.
- **A real SSH client other than OpenSSH 9.6** (the runner's), against OpenSSH 10.3. Another version may word a failure differently, and the
  tool then reports a general failure with ssh's exit code.
- **A lost reply.** The driver's retries are off, but no test cuts the connection in the middle of a write.
- **The review screen:** the preview was checked as data, and not seen in the terminal.
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
