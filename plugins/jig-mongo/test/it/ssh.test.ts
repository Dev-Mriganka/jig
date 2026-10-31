// jig-mongo's SSH route against a real SSH server: the tool starts `ssh -N -L` itself, with the key written to a private file for
// the moment ssh needs it, and reaches a database host that only the jump host can name. Real `ssh` words its failures, and the
// tool turns them into a line each.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { MongoClient } from "mongodb";
import { describeIt, must } from "../../../../test/support/it.ts";
import { ok } from "../support/harness.ts";
import { probe } from "../../src/route.ts";
import { jump, privateKey, scratch, strangerKey, sshWithKnownHosts, trustHostKeys } from "../support/jump.ts";
import { accounts, connection, rawClient, realHarness } from "../support/real.ts";

const KEY_REFERENCE = "env:JIG_IT_SSH_KEY";

describeIt(
    "jig-mongo's SSH route against a real SSH server",
    {
        service: "mongodb-ssh",
        variables: [
            "JIG_IT_MONGO_DIRECT_URI",
            "JIG_IT_MONGO_SSH_URI",
            "JIG_IT_MONGO_USER",
            "JIG_IT_MONGO_READONLY_USER",
            "JIG_IT_MONGO_PASSWORD",
            "JIG_IT_SSH_HOST",
            "JIG_IT_SSH_PORT",
            "JIG_IT_SSH_USER",
            "JIG_IT_SSH_KEY_FILE",
        ],
        hint: "a MongoDB replica set and an SSH server on its network (see the jig-mongo section)",
    },
    () => {
        const db = `jigit_${randomBytes(4).toString("hex")}`;
        const server = () => jump();
        const files = scratch();
        let raw: MongoClient;
        let trusted: string;
        let untrusted: string;

        /** A section with `staging` behind the SSH route, to the database host as the jump host names it. */
        const section = (via: Record<string, unknown> = {}) => ({
            connections: {
                staging: connection(must("JIG_IT_MONGO_SSH_URI"), accounts().user, {
                    via: {
                        ssh: {
                            host: server().host,
                            user: server().user,
                            key: KEY_REFERENCE,
                            port: server().port,
                            ...via,
                        },
                    },
                }),
            },
        });

        function harness(
            t: import("node:test").TestContext,
            knownHosts = trusted,
            via: Record<string, unknown> = {},
            key = privateKey(server()),
        ) {
            const h = realHarness(t, section(via));
            h.jig.useProgramsIn(sshWithKnownHosts(files.dir, knownHosts));
            h.jig.secrets.set(KEY_REFERENCE, key);
            return h;
        }

        before(async () => {
            raw = await rawClient(must("JIG_IT_MONGO_DIRECT_URI"));
            trusted = path.join(files.dir, "known_hosts");
            trustHostKeys(server(), trusted);
            untrusted = path.join(files.dir, "empty_known_hosts");
            writeFileSync(untrusted, "");
            const version = (await import("node:child_process")).execFileSync("ssh", ["-V"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
            console.log(`ssh client ${version.trim()}`);
            await raw
                .db(db)
                .collection("orders")
                .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
        });

        after(async () => {
            await raw?.db(db).dropDatabase();
            await raw?.close();
            files.remove();
        });

        test("a database that only the jump host can name is read and written through the forward", async (t) => {
            const h = harness(t);
            const target = { environment: "staging", database: db, collection: "orders" };
            assert.equal(
                ok(await h.call({ action: "count", ...target })),
                `mongo count staging ${db}.orders: 3 documents match (exact)`,
            );
            const inserted = await h.call({ action: "insert", ...target, documents: [{ n: 4 }] });
            assert.equal(ok(inserted), `mongo insert staging ${db}.orders: inserted 1 document`);
            assert.equal(await raw.db(db).collection("orders").countDocuments({ n: 4 }), 1);
            assert.match(ok(await h.call({ action: "find", ...target, filter: { n: 2 } })), /"n":2/);

            // One ssh, started once, for all of it: the forward lives with the connection.
            const started = h.jig.started.filter((program) => program.file === "ssh");
            assert.equal(started.length, 1);
            const args = started[0]?.args ?? [];
            const local = args[args.indexOf("-L") + 1] ?? "";
            const forward = /^127\.0\.0\.1:(\d+):(.+):(\d+)$/.exec(local);
            assert.ok(forward, local);
            const [, localPort, host, port] = forward;
            assert.equal(`${host}:${port}`, must("JIG_IT_MONGO_SSH_URI").replace("mongodb://", ""));
            const keyFile = args[args.indexOf("-i") + 1] ?? "";
            assert.deepEqual(
                [args[0], ...args.slice(args.indexOf("-F"), args.indexOf("-F") + 2), args.at(-1)],
                ["-N", "-F", "/dev/null", `${server().user}@${server().host}`],
            );
            for (const option of [
                "IdentitiesOnly=yes",
                "ExitOnForwardFailure=yes",
                "BatchMode=yes",
                "StrictHostKeyChecking=yes",
            ]) {
                assert.ok(args.includes(option), option);
            }
            // The key was on disk only while ssh signed in.
            assert.equal(existsSync(keyFile), false, "the key file is gone");
            assert.equal(await probe(Number(localPort)), true, "the forward is up while the connection is");
            await h.close();
            for (let attempt = 0; attempt < 50 && (await probe(Number(localPort))); attempt++)
                await new Promise((r) => setTimeout(r, 100));
            assert.equal(await probe(Number(localPort)), false, "the forward ends with the session");
        });

        test("a host key the user has not trusted is told as that, and nothing is connected", async (t) => {
            const h = harness(t, untrusted);
            const result = await h.call({
                action: "count",
                environment: "staging",
                database: db,
                collection: "orders",
            });
            assert.match(
                result.error?.message ?? "",
                /the bastion's host key is not trusted: connect to it once with ssh yourself to add it to known_hosts/,
            );
        });

        test("a key the server does not know is refused, and the message says to check the key", async (t) => {
            const key = readFileSync(strangerKey(files.dir), "utf8");
            const h = harness(t, trusted, {}, key);
            const result = await h.call({
                action: "count",
                environment: "staging",
                database: db,
                collection: "orders",
            });
            assert.match(
                result.error?.message ?? "",
                /the bastion refused the SSH key: check the key behind the key reference and the user/,
            );
        });

        test("text that is not a private key is told as an unreadable key", async (t) => {
            const h = harness(t, trusted, {}, "this is not a key\n");
            const result = await h.call({
                action: "count",
                environment: "staging",
                database: db,
                collection: "orders",
            });
            assert.match(
                result.error?.message ?? "",
                /the SSH key could not be read: it must be an unencrypted private key/,
            );
        });

        test("a jump host nobody answers at is told as unreachable", async (t) => {
            const h = harness(t, trusted, { port: 1 });
            const result = await h.call({
                action: "count",
                environment: "staging",
                database: db,
                collection: "orders",
            });
            assert.match(
                result.error?.message ?? "",
                /cannot reach the bastion: check the network and the VPN, then try again/,
            );
        });

        test("a user the server does not have is a refused key too", async (t) => {
            const h = harness(t, trusted, { user: `nobody${randomBytes(3).toString("hex")}` });
            const result = await h.call({
                action: "count",
                environment: "staging",
                database: db,
                collection: "orders",
            });
            assert.match(result.error?.message ?? "", /the bastion refused the SSH key/);
        });
    },
);
