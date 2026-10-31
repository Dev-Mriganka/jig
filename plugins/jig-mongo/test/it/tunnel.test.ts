// jig-mongo through a SOCKS tunnel to a replica set: the case a company needs. The tunnel is `ssh -N -D` to a real SSH server,
// started by a provider written as a company plugin would write it, and the database address is the replica set's own, with
// member names that only the jump host can resolve. So that nothing is reached by another road, the test first shows that this
// machine cannot reach the members, and then that the tool does through the tunnel: reads, a write to the primary, and a
// production read from a secondary.
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import type { TestContext } from "node:test";
import { MongoClient } from "mongodb";
import { describeIt, must, optional } from "../../../../test/support/it.ts";
import { probe } from "../../src/route.ts";
import { ok } from "../support/harness.ts";
import { jump, scratch, socksProvider, trustHostKeys } from "../support/jump.ts";
import { accounts, connection, rawClient, realHarness } from "../support/real.ts";

const TUNNEL = "jump-socks";

describeIt(
    "jig-mongo through a SOCKS tunnel to a replica set",
    {
        service: "mongodb-socks",
        variables: [
            "JIG_IT_MONGO_DIRECT_URI",
            "JIG_IT_MONGO_REPLICA_URI",
            "JIG_IT_MONGO_USER",
            "JIG_IT_MONGO_READONLY_USER",
            "JIG_IT_MONGO_PASSWORD",
            "JIG_IT_SSH_HOST",
            "JIG_IT_SSH_PORT",
            "JIG_IT_SSH_USER",
            "JIG_IT_SSH_KEY_FILE",
        ],
        hint: "a three-member MongoDB replica set whose names only an SSH server on its network can resolve",
    },
    () => {
        const db = `jigit_${randomBytes(4).toString("hex")}`;
        const replicaUri = () => must("JIG_IT_MONGO_REPLICA_URI");
        const files = scratch();
        let raw: MongoClient;
        let knownHosts: string;
        /** Every tunnel the provider opened, in order. */
        const opened: Array<{ port: number; closed: boolean }> = [];

        /** The members of the replica set, as the address names them. */
        const members = (): string[] =>
            (/^mongodb:\/\/([^/?]+)/.exec(replicaUri())?.[1] ?? "").split(",").filter((member) => member !== "");

        const section = () => ({
            connections: {
                staging: connection(replicaUri(), accounts().user, { via: { tunnel: TUNNEL } }),
                production: connection(replicaUri(), accounts().readonlyUser, { via: { tunnel: TUNNEL } }),
                // The same address with no route: this machine cannot reach the members by their names.
                unrouted: connection(replicaUri(), accounts().user),
            },
            access: {
                unrouted: { deny: [] },
                production: { allow: { [`${db}.orders`]: ["_id", "n", "status"] } },
            },
        });

        function harness(t: TestContext, hosts = knownHosts) {
            const h = realHarness(t, section());
            h.jig.kinds.set("unrouted", "test");
            h.jig.api.tunnels.register(TUNNEL, socksProvider(jump(), hosts, opened));
            return h;
        }
        const on = (collection: string, environment = "staging") => ({ environment, database: db, collection });

        /** Whether this machine can look up the first member's name. In CI it cannot: only the jump host's network knows it. */
        async function resolves(): Promise<boolean> {
            const host = (members()[0] ?? "").replace(/:\d+$/, "");
            return lookup(host).then(
                () => true,
                () => false,
            );
        }

        /** A client of the test's own through its own tunnel, to ask one member what it served. */
        async function throughProxy(port: number, member: string): Promise<MongoClient> {
            const who = accounts();
            const client = new MongoClient(`mongodb://${member}/?directConnection=true`, {
                auth: { username: who.user, password: who.password },
                authSource: "admin",
                proxyHost: "127.0.0.1",
                proxyPort: port,
                serverSelectionTimeoutMS: 20_000,
            });
            await client.connect();
            return client;
        }

        before(async () => {
            raw = await rawClient(must("JIG_IT_MONGO_DIRECT_URI"), { writeConcern: { w: "majority" } });
            knownHosts = path.join(files.dir, "known_hosts");
            trustHostKeys(jump(), knownHosts);
            await raw
                .db(db)
                .collection("orders")
                .insertMany([
                    { n: 1, status: "open", secret: "not-allowed" },
                    { n: 2, status: "open", secret: "not-allowed" },
                    { n: 3, status: "closed", secret: "not-allowed" },
                ]);
        });

        after(async () => {
            await raw?.db(db).dropDatabase();
            await raw?.close();
            files.remove();
        });

        test("without the tunnel this machine cannot reach the members, and the tool says so", async (t) => {
            if (await resolves()) {
                if (optional("JIG_IT_MONGO_MEMBERS_HIDDEN") !== undefined) {
                    assert.fail("JIG_IT_MONGO_MEMBERS_HIDDEN says the members cannot be looked up here, but they can");
                }
                t.skip(
                    "the members' names resolve on this machine, so the tunnel would not be what carries the traffic",
                );
                return;
            }
            const h = harness(t);
            const result = await h.call({ action: "count", ...on("orders", "unrouted") });
            assert.equal(
                result.error?.message,
                `mongo count unrouted ${db}.orders: cannot reach the unrouted database: check the network, the VPN and the route, then try again`,
            );
            // The driver itself fails the same way: it looks the names up on this side.
            const bare = new MongoClient(replicaUri(), {
                auth: { username: accounts().user, password: accounts().password },
                authSource: "admin",
                serverSelectionTimeoutMS: 3000,
            });
            await assert.rejects(bare.connect(), { name: "MongoServerSelectionError" });
            await bare.close();
        });

        test("through the tunnel the tool reads and writes the replica set by the members' own names", async (t) => {
            const h = harness(t);
            assert.equal(opened.length, 0);
            assert.equal(
                ok(await h.call({ action: "count", ...on("orders") })),
                `mongo count staging ${db}.orders: 3 documents match (exact)`,
            );
            assert.equal(opened.length, 1, "one tunnel for the connection");
            const inserted = await h.call({ action: "insert", ...on("orders"), documents: [{ n: 4, status: "new" }] });
            assert.equal(ok(inserted), `mongo insert staging ${db}.orders: inserted 1 document`);
            assert.match(inserted.preview?.body ?? "", /Documents:/);
            // The write went to the primary, and the other members have it.
            assert.equal(await raw.db(db).collection("orders").countDocuments({ n: 4 }), 1);
            ok(await h.call({ action: "count", ...on("orders") }));
            assert.equal(opened.length, 1, "the next call reuses the tunnel");

            const updated = await h.call({
                action: "update",
                ...on("orders"),
                filter: { n: 4 },
                update: { $set: { status: "done" } },
                which: "one",
            });
            assert.match(ok(updated), /matched 1 document, modified 1/);
            assert.equal((await raw.db(db).collection("orders").findOne({ n: 4 }))?.status, "done");
            await raw.db(db).collection("orders").deleteOne({ n: 4 });
        });

        test("a production read goes to a secondary, through the same tunnel, and shows only the allowed fields", async (t) => {
            const h = harness(t);
            // A tunnel of the test's own, to ask each member how many reads of the collection it has served.
            const provider = socksProvider(jump(), knownHosts);
            const own = await provider.open({ host: "unused", port: 1 });
            t.after(() => void own.close());
            const clients = new Map<string, MongoClient>();
            for (const member of members()) clients.set(member, await throughProxy(own.port, member));
            t.after(async () => void (await Promise.all([...clients.values()].map((client) => client.close()))));
            const roles = new Map<string, boolean>();
            for (const [member, client] of clients) {
                roles.set(member, (await client.db("admin").command({ hello: 1 })).isWritablePrimary === true);
            }
            assert.equal([...roles.values()].filter(Boolean).length, 1, "one primary");
            assert.equal(roles.size, 3);

            const served = async (): Promise<Map<string, number>> => {
                const counts = new Map<string, number>();
                for (const [member, client] of clients) {
                    const [stats] = await client
                        .db(db)
                        .collection("orders")
                        .aggregate([{ $collStats: { latencyStats: {} } }], { readPreference: "secondaryPreferred" })
                        .toArray();
                    counts.set(member, Number(stats?.latencyStats?.reads?.ops ?? 0));
                }
                return counts;
            };

            // Reads settle on the secondaries once the seed has been replicated; the first call waits for it.
            let rows: unknown[] = [];
            for (let attempt = 0; attempt < 50 && rows.length < 3; attempt++) {
                const text = ok(await h.call({ action: "find", ...on("orders", "production"), sort: { n: 1 } }));
                rows = text
                    .split("\n")
                    .slice(1)
                    .map((line) => JSON.parse(line));
                if (rows.length < 3) await new Promise((resolve) => setTimeout(resolve, 200));
            }
            assert.equal(rows.length, 3);
            for (const row of rows as Array<Record<string, unknown>>) {
                assert.deepEqual(
                    Object.keys(row).sort(),
                    ["_id", "n", "status"],
                    "the field `secret` is not in the allow list",
                );
            }
            const before = await served();
            for (let call = 0; call < 6; call++) ok(await h.call({ action: "find", ...on("orders", "production") }));
            const after = await served();
            const delta = new Map([...after].map(([member, count]) => [member, count - (before.get(member) ?? 0)]));
            const primary = [...roles].find(([, isPrimary]) => isPrimary)?.[0] ?? "";
            const secondaries = [...delta].filter(([member]) => member !== primary);
            const fromSecondaries = secondaries.reduce((sum, [, count]) => sum + count, 0);
            // Each member also served the one `$collStats` that read the counter before: that is the 1 the primary shows.
            assert.ok(fromSecondaries >= 6 + 2, `the secondaries served the finds: ${JSON.stringify([...delta])}`);
            assert.ok(
                (delta.get(primary) ?? 99) <= 1,
                `the primary served none of them: ${JSON.stringify([...delta])}`,
            );
        });

        test("the tunnel ends with the session, and a tunnel that cannot be opened is told in a line", async (t) => {
            const h = harness(t);
            ok(await h.call({ action: "count", ...on("orders") }));
            const record = opened.at(-1);
            assert.ok(record && !record.closed);
            assert.equal(await probe(record.port), true);
            await h.close();
            assert.equal(record.closed, true);
            for (let attempt = 0; attempt < 50 && (await probe(record.port)); attempt++)
                await new Promise((r) => setTimeout(r, 100));
            assert.equal(await probe(record.port), false, "the proxy is gone");

            // A host key nobody trusted: ssh -D ends before it opens the port, and the tool passes on a short line.
            const distrust = path.join(files.dir, "distrust");
            (await import("node:fs")).writeFileSync(distrust, "");
            const strict = harness(t, distrust);
            const result = await strict.call({ action: "count", ...on("orders") });
            assert.match(
                result.error?.message ?? "",
                new RegExp(`the tunnel "${TUNNEL}" could not be opened: .*ssh -D ended: .*host key`, "i"),
            );
            assert.ok(!(result.error?.message ?? "").includes(jump().keyFile));
        });
    },
);
