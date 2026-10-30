// The shape of a call: which parameters each action takes, their types and ranges, and the usage line that tells the model what to change.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACTION_NAMES, ACTIONS, DEFAULT_MAX_TIME_MS, parameters, parseCall, usage } from "../src/params.ts";
import { InputError } from "../src/values.ts";

const base = { environment: "staging", database: "orders", collection: "orders" };
const refused = (input: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(
        () => parseCall(input),
        (error: unknown) => error instanceof InputError && pattern.test(error.message),
        JSON.stringify(input).slice(0, 80),
    );

describe("the actions", () => {
    test("every action of the README is there, with its kind", () => {
        assert.deepEqual(ACTION_NAMES, [
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
        ]);
        for (const name of ACTION_NAMES) {
            const expected = ["insert", "update", "replace", "delete", "bulk", "create-index", "drop-index"].includes(
                name,
            )
                ? "write"
                : "read";
            assert.equal(ACTIONS[name].effect, expected, name);
        }
    });

    test("the schema lists the same actions, and says what each needs", () => {
        const action = (parameters.properties as any).action;
        assert.deepEqual(action.enum, ACTION_NAMES);
        assert.match(action.description, /find\(database,collection\)/);
        assert.match(action.description, /update\(database,collection,filter,which\)/);
    });

    test("the usage line names the required parameters and marks the optional ones", () => {
        assert.equal(
            usage("find"),
            "Usage: mongo find {environment, database, collection, filter?, projection?, sort?, limit?, maxTimeMS?}",
        );
        assert.match(usage("update"), /filter, which, update\?, pipeline\?, limit\?/);
    });
});

describe("checking a call", () => {
    test("a good call is returned typed, with the default time limit and only the parameters that were given", () => {
        const call = parseCall({ action: "find", ...base, filter: { status: "open" }, limit: 5 });
        assert.deepEqual(call, {
            action: "find",
            maxTimeMS: DEFAULT_MAX_TIME_MS,
            ...base,
            filter: { status: "open" },
            limit: 5,
        });
        assert.deepEqual(parseCall({ action: "databases", environment: "staging", filter: null }), {
            action: "databases",
            maxTimeMS: DEFAULT_MAX_TIME_MS,
            environment: "staging",
        });
    });

    test("an unknown action, a missing parameter and a parameter the action does not use each get the usage line", () => {
        refused({ action: "launch", ...base }, /unknown action "launch"; use one of databases, collections/);
        refused({ ...base }, /unknown action undefined/);
        refused(
            { action: "find", environment: "staging", collection: "orders" },
            /mongo find needs database\. Usage: mongo find \{environment, database/,
        );
        refused({ action: "count", ...base, sort: { a: 1 } }, /mongo count does not use sort\. Usage: mongo count/);
        refused({ action: "find", ...base, which: "one" }, /does not use which/);
        refused({ action: "distinct", ...base }, /needs field/);
    });

    test("types: text, objects and lists", () => {
        refused({ action: "find", ...base, filter: "status" }, /filter must be an object/);
        refused({ action: "find", ...base, filter: [{ a: 1 }] }, /filter must be an object/);
        refused({ action: "find", ...base, environment: 5 }, /environment must be text/);
        refused({ action: "aggregate", ...base, pipeline: { $match: {} } }, /pipeline must be a list of objects/);
        refused({ action: "aggregate", ...base, pipeline: [] }, /pipeline must be a list of objects/);
        refused({ action: "aggregate", ...base, pipeline: [1] }, /pipeline must be a list of objects/);
        refused({ action: "insert", ...base, documents: "x" }, /documents must be a list of objects/);
    });

    test("names: a database and a collection are plain names", () => {
        refused({ action: "find", ...base, database: "or ders" }, /plain database name/);
        refused({ action: "find", ...base, database: "a.b" }, /plain database name/);
        refused({ action: "find", ...base, collection: "$cmd" }, /plain collection name/);
        refused({ action: "find", ...base, collection: "a/b" }, /plain collection name/);
        parseCall({ action: "find", ...base, collection: "fs.files" });
    });

    test("limit is a whole number from 1 to 2000, and maxTimeMS from 1 to 60000", () => {
        for (const limit of [0, -1, 2001, 1.5, "5"])
            refused({ action: "find", ...base, limit }, /limit must be a whole number from 1 to 2000/);
        for (const limit of [1, 2000]) parseCall({ action: "find", ...base, limit });
        for (const maxTimeMS of [0, 60001, 1.5, "5"])
            refused({ action: "find", ...base, maxTimeMS }, /maxTimeMS must be a whole number from 1 to 60000/);
        assert.equal(parseCall({ action: "find", ...base, maxTimeMS: 60000 }).maxTimeMS, 60000);
    });

    test("which, verbosity and distinct's field", () => {
        refused(
            { action: "update", ...base, filter: { a: 1 }, update: { $set: { a: 2 } }, which: "all" },
            /which must be "one" or "many"/,
        );
        refused({ action: "explain", ...base, verbosity: "allPlansExecution" }, /verbosity must be/);
        refused({ action: "distinct", ...base, field: "$status" }, /distinct needs a field/);
        refused({ action: "distinct", ...base, field: "a b" }, /distinct needs a field/);
        assert.equal(parseCall({ action: "distinct", ...base, field: "customer.region" }).field, "customer.region");
    });

    test("an update has operators or stages, not both and not neither; an explain has a find or a pipeline, not both", () => {
        const update = { action: "update", ...base, filter: { a: 1 }, which: "one" };
        refused(update, /needs update .* or pipeline .*not both/);
        refused({ ...update, update: { $set: { a: 1 } }, pipeline: [{ $set: { a: 1 } }] }, /not both/);
        parseCall({ ...update, update: { $set: { a: 1 } } });
        parseCall({ ...update, pipeline: [{ $set: { a: 1 } }] });
        refused({ action: "explain", ...base, pipeline: [{ $match: {} }], sort: { a: 1 } }, /not both/);
    });

    test("a request longer than 256 KiB, and malformed Extended JSON in any object or list", () => {
        refused({ action: "insert", ...base, documents: [{ text: "x".repeat(300 * 1024) }] }, /longer than 256 KiB/);
        refused({ action: "find", ...base, filter: { _id: { $oid: "nope" } } }, /\$oid.*24 hexadecimal/);
        refused({ action: "aggregate", ...base, pipeline: [{ $match: { d: { $date: "tomorrow" } } }] }, /\$date/);
        refused({ action: "insert", ...base, documents: [{ n: { $numberInt: "x" } }] }, /\$numberInt/);
    });
});
