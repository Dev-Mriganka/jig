// The tool as Pi runs it, through jig-core's steps: classify, ask, execute. Reads in a test environment and in production, what the
// model is told when the database or the route fails, the time limit of a call, and the end of the session.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { driverError } from "./support/fake-backend.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { InputError } from "../src/values.ts";
import { PRODUCTION_PASSWORD, STAGING_PASSWORD } from "./support/section.ts";

let h: Harness;
beforeEach(() => void (h = setupHarness()));
afterEach(async () => h.close());

const target = { database: "orders", collection: "orders" };
const find = (environment: string, extra: Record<string, unknown> = {}) => ({
    action: "find",
    environment,
    ...target,
    ...extra,
});
const factsOf = (id: string) => Object.assign({}, ...(h.jig.facts.get(id) ?? []));

describe("a read in a test environment", () => {
    test("runs without asking, connects as configured, and returns the documents without what is denied", async () => {
        h.backend.answers.find = [{ _id: 1, status: "open", notes: "private", password: "p" }];
        const result = await h.call(find("staging", { filter: { status: "open" } }));
        assert.equal(ok(result), 'mongo find staging orders.orders: 1 document\n{"_id":1,"status":"open"}');
        assert.equal(result.preview, undefined, "a read does not ask");
        assert.deepEqual(factsOf(result.id), { returned: 1 });
        assert.deepEqual(h.connects, [
            {
                environment: "staging",
                uri: "mongodb://db.staging.example.com:27017",
                user: "agent",
                password: STAGING_PASSWORD.value,
                production: false,
            },
        ]);
    });

    test("the connection is kept for the next call, and the password never reaches a result", async () => {
        const texts = [
            ok(await h.call(find("staging"))),
            ok(await h.call({ action: "count", environment: "staging", ...target })),
            ok(await h.call({ action: "databases", environment: "staging" })),
        ];
        assert.equal(h.connects.length, 1);
        assert.deepEqual(h.jig.resolved, ["pass:mongo/staging"]);
        for (const text of texts) assert.ok(!text.includes(STAGING_PASSWORD.value));
    });

    test("the time limit of the call goes to the database, and the result has details and no documents in them", async () => {
        const result = await h.call(find("staging", { maxTimeMS: 2500, limit: 3 }));
        assert.equal(h.backend.calls[0]?.req.maxTimeMS, 2500);
        assert.equal((h.backend.calls[0]!.query as any).limit, 3);
        assert.deepEqual(result.details, { action: "find", environment: "staging", count: 0, partial: false });
    });
});

describe("a read in production", () => {
    test("reads only the allowed fields through a forced projection, from a secondary where there is one", async () => {
        h.backend.answers.find = [{ _id: 1, status: "open", items: [{ sku: "a", token: "t" }], internalNotes: "x" }];
        const result = await h.call(find("production", { filter: { status: "open" } }));
        assert.equal(
            ok(result),
            'mongo find production orders.orders: 1 document\n{"_id":1,"status":"open","items":[{"sku":"a"}]}',
        );
        assert.deepEqual((h.backend.calls[0]!.query as any).projection, { _id: 1, status: 1, items: 1, createdAt: 1 });
        assert.deepEqual(h.connects[0], {
            environment: "production",
            uri: "mongodb://db.example.com:27017",
            user: "agent-readonly",
            password: PRODUCTION_PASSWORD.value,
            production: true,
        });
    });

    test("the tool leaves masking to jig-core, whose backstop masks every production result", () => {
        assert.equal(h.declaration.masksOwnResults, undefined);
    });

    test("a write is blocked, and the database is never touched", async () => {
        const result = await h.call({
            action: "delete",
            environment: "production",
            ...target,
            filter: { status: "open" },
            which: "one",
        });
        assert.match(result.blocked ?? "", /production is production, which is read-only/);
        assert.equal(h.backend.calls.length, 0);
        assert.equal(h.connects.length, 0);
    });
});

describe("when the database or the route fails", () => {
    const failing = async (error: unknown, environment = "staging") => {
        h.backend.answers.find = () => {
            throw error;
        };
        const result = await h.call(find(environment));
        return result.error?.message ?? `no error: ${result.text}`;
    };

    test("each failure is one line that says what to do, with the call named", async () => {
        assert.equal(
            await failing(driverError("MongoServerSelectionError")),
            "mongo find staging orders.orders: cannot reach the staging database: check the network, the VPN and the route, then try again",
        );
        assert.equal(
            await failing(driverError("MongoNetworkError")),
            "mongo find staging orders.orders: the connection to the database dropped",
        );
        assert.equal(
            await failing(driverError("MongoServerError", "x", { code: 18 })),
            "mongo find staging orders.orders: the database refused the sign-in for staging: check the user and the password reference",
        );
        assert.equal(
            await failing(driverError("MongoServerError", "x", { code: 13 })),
            "mongo find staging orders.orders: the database user cannot do this in staging (Unauthorized): it needs another role",
        );
        assert.equal(
            await failing(driverError("MongoServerError", "x", { code: 50 })),
            "mongo find staging orders.orders: the query ran longer than maxTimeMS 10000: narrow the filter to an indexed field, or raise maxTimeMS",
        );
        assert.equal(
            await failing(new Error("something odd")),
            "mongo find staging orders.orders: the database driver failed (unknown error); try again or narrow the request",
        );
    });

    test("a test environment gets the server's own words, a production one never does: they can echo values", async () => {
        const error = driverError("MongoServerError", "Failed to parse: customer 4111 not found", {
            code: 8000,
            codeName: "AtlasError",
        });
        assert.match(
            await failing(error),
            /rejected the request \(AtlasError\): Failed to parse: customer 4111 not found$/,
        );
        assert.equal(
            await failing(error, "production"),
            "mongo find production orders.orders: the database rejected the request (AtlasError)",
        );
    });

    test("a connection that failed is dropped: the next call opens a new one; one the server answered on is kept", async () => {
        await failing(driverError("MongoNetworkError"));
        h.backend.answers.find = [];
        ok(await h.call(find("staging")));
        assert.equal(h.connects.length, 2);
        h.backend.answers.find = () => {
            throw driverError("MongoServerError", "bad", { code: 2, codeName: "BadValue" });
        };
        await h.call(find("staging"));
        h.backend.answers.find = [];
        ok(await h.call(find("staging")));
        assert.equal(h.connects.length, 2);
    });

    test("a call that is over its time, or cancelled, ends with one line", async () => {
        h.close();
        h = setupHarness({ deadlineMs: 60 });
        h.backend.answers.find = () => new Promise(() => {});
        assert.equal(
            (await h.call(find("staging"))).error?.message,
            "mongo find staging orders.orders: the call hit its time limit or was cancelled",
        );
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        h.close();
        h = setupHarness();
        h.backend.answers.find = () => new Promise(() => {});
        assert.match(
            (await h.call(find("staging"), { signal: controller.signal })).error?.message ?? "",
            /the call hit its time limit or was cancelled/,
        );
    });

    test("an error of the model's own making (invalid input found while running) passes through unchanged", async () => {
        h.backend.answers.find = () => {
            throw new InputError("not for the database");
        };
        const result = await h.call(find("staging"));
        assert.equal(result.error?.message, "not for the database");
        assert.equal(h.connects.length, 1, "and the connection is kept");
    });
});

describe("the end of the session, and a jig-core that is not there", () => {
    test("the connections are closed when the session ends", async () => {
        ok(await h.call(find("staging")));
        assert.equal(h.backend.closed, 0);
        for (const handler of h.handlers.get("session_shutdown") ?? []) await handler();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(h.backend.closed, 1);
    });

    test("without jig-core the tool does not run, and does not connect", async () => {
        h.jig.remove();
        await assert.rejects(
            h.tool.execute(
                "call-x",
                { action: "databases", environment: "staging" } as never,
                undefined,
                undefined,
                {} as never,
            ),
            /jig-core is not loaded/,
        );
        assert.equal(h.connects.length, 0);
        assert.equal(h.backend.calls.length, 0);
    });
});

describe("the tool", () => {
    test("runs one call at a time and in order, so a write is done before the read that checks it", () => {
        assert.equal(h.tool.executionMode, "sequential");
        assert.equal(h.tool.name, "mongo");
    });

    test("every action is in its description of parameters", () => {
        const action = (h.tool.parameters as any).properties.action;
        for (const name of [
            "databases",
            "collections",
            "schema",
            "stats",
            "indexes",
            "index-stats",
            "explain",
            "count",
            "find",
            "distinct",
            "sample",
            "aggregate",
            "insert",
            "update",
            "replace",
            "delete",
            "bulk",
            "create-index",
            "drop-index",
        ]) {
            assert.ok(action.enum.includes(name), name);
        }
    });
});

describe("an environment with several connections", () => {
    const section = () => ({
        connections: {
            staging: {
                orders: {
                    uri: "mongodb://orders.staging.example.com:27017",
                    user: "agent",
                    password: STAGING_PASSWORD.reference,
                },
                billing: {
                    uri: "mongodb://billing.staging.example.com:27017",
                    user: "agent",
                    password: STAGING_PASSWORD.reference,
                },
            },
            production: {
                uri: "mongodb://db.example.com:27017",
                user: "agent-readonly",
                password: PRODUCTION_PASSWORD.reference,
            },
        },
        access: {
            staging: { orders: { deny: ["*.notes"] }, billing: { deny: ["cards.*"] } },
            production: { allow: { "orders.orders": ["_id", "status"] } },
        },
    });
    beforeEach(() => h.configure(section()));

    test("needs `cluster`, and a call without it is refused before anyone is asked, naming the choices", async () => {
        const result = await h.call(find("staging"));
        assert.equal(result.blocked, "staging has several connections: add cluster, one of orders, billing");
        assert.equal(h.connects.length, 0);
        assert.throws(
            () => h.declaration.classify({ action: "count", environment: "staging", ...target }),
            /staging has several connections: add cluster/,
        );
    });

    test("`cluster` picks the connection: each has its own address, and they are kept separately", async () => {
        ok(await h.call(find("staging", { cluster: "orders" })));
        ok(await h.call(find("staging", { cluster: "billing" })));
        ok(await h.call(find("staging", { cluster: "orders" })));
        assert.deepEqual(
            h.connects.map((connect) => [connect.environment, connect.cluster, connect.uri]),
            [
                ["staging", "orders", "mongodb://orders.staging.example.com:27017"],
                ["staging", "billing", "mongodb://billing.staging.example.com:27017"],
            ],
            "one connection each, and the first is reused",
        );
    });

    test("a name that is not one of them is refused with the names there are", async () => {
        const result = await h.call(find("staging", { cluster: "invoices" }));
        assert.equal(result.blocked, 'staging has no connection named "invoices"; cluster is one of orders, billing');
        const odd = await h.call(find("staging", { cluster: "../x" }));
        assert.match(odd.blocked ?? "", /staging has no connection named "\.\.\/x"/);
        const notText = await h.call(find("staging", { cluster: 7 }));
        assert.match(notText.blocked ?? "", /cluster must be text/);
    });

    test("an environment with one connection refuses it, and says to leave it out", async () => {
        const result = await h.call(find("production", { cluster: "orders" }));
        assert.equal(result.blocked, "production has one connection, so cluster is not used there: leave it out");
        assert.equal(
            ok(await h.call(find("production", { projection: { status: 1 } }))).startsWith("mongo find production"),
            true,
        );
    });

    test("an unknown environment is named before its clusters are", async () => {
        const result = await h.call(find("nowhere", { cluster: "orders" }));
        assert.match(result.blocked ?? "", /unknown environment "nowhere"; configured: staging, production/);
    });

    test("is classified by its environment: the connection's name changes neither the kind nor the effect", async () => {
        const read = await h.call(find("staging", { cluster: "billing" }));
        assert.deepEqual(read.cls, { action: "find", environment: "staging", effect: "read" });
        const write = await h.call({
            action: "insert",
            environment: "staging",
            cluster: "billing",
            ...target,
            documents: [{ n: 1 }],
        });
        assert.deepEqual(write.cls, { action: "insert", environment: "staging", effect: "write" });
        // Production is read-only whatever the connection.
        const refused = await h.call({ action: "insert", environment: "production", ...target, documents: [{ n: 1 }] });
        assert.match(refused.blocked ?? "", /production, which is read-only/);
    });

    test("the access rules of each connection apply to it alone", async () => {
        const billing = await h.call({
            action: "count",
            environment: "staging",
            cluster: "billing",
            database: "cards",
            collection: "visa",
        });
        assert.match(billing.blocked ?? "", /cards\.visa is denied by the access list/);
        const orders = await h.call({
            action: "count",
            environment: "staging",
            cluster: "orders",
            database: "cards",
            collection: "visa",
        });
        ok(orders);
        h.backend.answers.find = [{ _id: 1, notes: "private", status: "open" }];
        assert.equal(
            ok(await h.call(find("staging", { cluster: "orders" }))),
            'mongo find staging/orders orders.orders: 1 document\n{"_id":1,"status":"open"}',
            "orders hides notes",
        );
        h.backend.answers.find = [{ _id: 1, notes: "kept", status: "open" }];
        assert.match(ok(await h.call(find("staging", { cluster: "billing" }))), /"notes":"kept"/);
    });

    test("a result names the connection, and its details and facts carry it", async () => {
        h.backend.answers.find = [];
        const result = await h.call(find("staging", { cluster: "billing" }));
        assert.match(ok(result), /^mongo find staging\/billing orders\.orders: /);
        assert.deepEqual(result.details, {
            action: "find",
            environment: "staging",
            cluster: "billing",
            count: 0,
            partial: false,
        });
        assert.deepEqual(factsOf(result.id), { returned: 0, cluster: "billing" });
    });

    test("a write is previewed with its connection, and the fingerprint tells one connection from another", async () => {
        h.backend.answers.count = 3;
        const insert = (cluster: string) => ({
            action: "update",
            environment: "staging",
            cluster,
            database: "orders",
            collection: "orders",
            filter: { status: "stuck" },
            update: { $set: { status: "shipped" } },
            which: "many",
        });
        const orders = await h.call(insert("orders"));
        ok(orders);
        assert.equal(orders.preview?.summary, "update many in orders.orders (staging/orders): 3 documents match");
        assert.match(
            orders.preview?.body ?? "",
            /Environment: staging\n\nConnection: orders\n\nCollection: orders\.orders/,
        );
        const billing = await h.call(insert("billing"));
        ok(billing);
        assert.notEqual(orders.preview?.fingerprint, billing.preview?.fingerprint);
    });

    test("a failure names the connection, so the model can tell which one is down", async () => {
        const harness = setupHarness({
            connect: async () => {
                throw driverError("MongoServerSelectionError", "connect ECONNREFUSED 10.0.0.5:27017");
            },
        });
        harness.configure(section());
        try {
            const result = await harness.call(find("staging", { cluster: "billing" }));
            assert.match(result.error?.message ?? "", /cannot reach the staging\/billing database/);
            assert.ok(!(result.error?.message ?? "").includes("10.0.0.5"));
        } finally {
            await harness.close();
        }
    });
});
