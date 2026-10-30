// Filters and pipelines are walked in full before anything runs. Every way a denied field could be reached is tried here: the key
// of a filter, a rename, `$getField`, a variable, `$lookup`, `$facet`, `$unionWith`, `$replaceRoot`, JavaScript, and `$out`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAccess, readAllow, readDeny } from "../src/access.ts";
import type { Access, AccessRules } from "../src/access.ts";
import { newCtx } from "../src/expr.ts";
import { checkFilter } from "../src/filter.ts";
import { scanJavaScript } from "../src/params.ts";
import { checkPipeline, checkUpdatePipeline } from "../src/pipeline.ts";
import { InputError } from "../src/values.ts";

const ns = { db: "orders", coll: "orders" };

function deny(...patterns: string[]): Access {
    const errors: string[] = [];
    const rules = readDeny(patterns, "deny", errors);
    assert.deepEqual(errors, []);
    return createAccess({ mode: "deny", deny: rules as NonNullable<typeof rules>, javascript: false });
}

function allow(map: Record<string, string[]>): Access {
    const errors: string[] = [];
    const rules = readAllow(map, "allow", errors);
    assert.deepEqual(errors, []);
    return createAccess({ mode: "allow", allow: rules as NonNullable<typeof rules>, javascript: false } as AccessRules);
}

const ORDERS = ["_id", "status", "items", "createdAt"];
const production = () => allow({ "orders.orders": ORDERS, "orders.customers": ["_id", "name"] });
const staging = () => deny("billing.cards", "*.notes", "*.profile.ssn");

const refused = (run: () => unknown, pattern: RegExp, what = "") =>
    assert.throws(
        run,
        (error: unknown) => error instanceof InputError && pattern.test(error.message),
        `${what}: ${pattern}`,
    );
const filterOf = (access: Access, filter: unknown) => checkFilter(filter, newCtx(access.view([ns])));

describe("a filter", () => {
    test("allowed fields, typed values and every common operator pass", () => {
        filterOf(staging(), {
            status: "open",
            "customer.name": { $regex: "^A", $options: "i" },
            _id: { $oid: "65f1f1f1f1f1f1f1f1f1f1f1" },
            createdAt: { $gt: { $date: "2026-01-01T00:00:00Z" }, $lte: { $date: "2026-02-01T00:00:00Z" } },
            qty: { $in: [1, 2], $nin: [3], $exists: true, $type: "int", $mod: [2, 0] },
            tags: { $all: ["a", "b"], $size: 2 },
            items: { $elemMatch: { sku: "a", qty: { $gt: 1 } } },
            flags: { $bitsAllSet: 5 },
            place: { $near: { $geometry: { type: "Point", coordinates: [1, 2] } } },
            $or: [{ a: 1 }, { $and: [{ b: 2 }, { $nor: [{ c: 3 }] }] }],
            $comment: "debugging",
            total: { $not: { $gt: 5 } },
            $expr: { $gt: ["$total", 10] },
        });
    });

    test("a denied field is refused wherever it appears: a key, a dotted key, below $and, $elemMatch and $not", () => {
        const cases: Array<[unknown, string]> = [
            [{ password: "x" }, "a credential name"],
            [{ "customer.apiKey": 1 }, "a dotted credential name"],
            [{ "customer.password.hash": 1 }, "a credential in the middle"],
            [{ notes: "x" }, "a denied name"],
            [{ "a.b.notes": 1 }, "a denied name at depth"],
            [{ "profile.ssn": "1" }, "a denied path"],
            [{ $and: [{ status: 1 }, { token: 2 }] }, "below $and"],
            [{ $or: [{ $nor: [{ notes: 1 }] }] }, "below $nor"],
            [{ items: { $elemMatch: { token: 1 } } }, "inside $elemMatch"],
            [{ items: { $elemMatch: { sub: { $elemMatch: { notes: 1 } } } } }, "inside two $elemMatch"],
            [{ status: { $not: { $elemMatch: { password: 1 } } } }, "inside $not"],
            [{ "items.0.token": 1 }, "an array position"],
            [{ a: { $in: [{ notes: 1 }] } }, "a literal document in $in"],
            [{ profile: { ssn: "123" } }, "a nested literal document"],
            [{ a: { $eq: { b: { notes: 1 } } } }, "a deep literal"],
            [{ $expr: { $eq: ["$password", 1] } }, "$expr"],
            [{ $expr: { $gt: [{ $strLenCP: "$customer.apiKey" }, 3] } }, "$expr, nested"],
        ];
        for (const [filter, what] of cases)
            refused(() => filterOf(staging(), filter), /looks like a credential|denied|holds a denied field/, what);
    });

    test("with an allow list a field that is not listed is refused, and the message says what is allowed", () => {
        refused(
            () => filterOf(production(), { internalNotes: "x" }),
            /"internalNotes" is not allowed in orders\.orders; allowed: _id, status, items, createdAt/,
        );
        refused(() => filterOf(production(), { status: "x", $or: [{ other: 1 }] }), /"other" is not allowed/);
        filterOf(production(), { status: "x", "items.sku": "a", items: { $elemMatch: { sku: "a" } } });
    });

    test("with an allow list a field that is only partly listed cannot be filtered on, or matched whole", () => {
        const partial = allow({ "orders.orders": ["_id", "items.sku"] });
        filterOf(partial, { "items.sku": "a" });
        refused(() => filterOf(partial, { items: { $exists: true } }), /only partly allowed/);
        refused(() => filterOf(partial, { items: { sku: "a", price: 5 } }), /only partly allowed|not allowed/);
    });

    test("what cannot be checked is refused: $jsonSchema, unknown operators, $text with an allow list", () => {
        refused(() => filterOf(staging(), { $jsonSchema: { required: ["a"] } }), /\$jsonSchema/);
        refused(() => filterOf(staging(), { $weird: 1 }), /not supported at the top/);
        refused(() => filterOf(staging(), { a: { $weird: 1 } }), /the query operator \$weird is not supported/);
        refused(
            () => filterOf(production(), { $text: { $search: "x" } }),
            /\$text searches fields the allow list cannot check/,
        );
        filterOf(staging(), { $text: { $search: "x" } });
        refused(() => filterOf(staging(), "status"), /must be an object/);
        refused(() => filterOf(staging(), { $and: "x" }), /list of filters/);
    });

    test("a filter that nests too deeply is refused", () => {
        let deep: Record<string, unknown> = { a: 1 };
        for (let level = 0; level < 40; level++) deep = { $and: [deep] };
        refused(() => filterOf(staging(), deep), /nests more than 32/);
    });
});

describe("a pipeline: what may pass", () => {
    test("a grouping, a sort and a limit over allowed fields, in either kind of environment", () => {
        const pipeline = [
            { $match: { status: "open" } },
            { $group: { _id: "$status", total: { $sum: "$items.price" }, count: { $sum: 1 } } },
            { $sort: { total: -1 } },
            { $limit: 10 },
        ];
        const checked = checkPipeline(pipeline, ns, staging());
        assert.deepEqual(checked.stages, pipeline);
        assert.deepEqual(checked.reads, [ns]);
        assert.equal(checked.output, undefined);
        checkPipeline(pipeline, ns, production());
    });

    test("computed fields, $unwind, $project, $count, $sample, $skip and $facet over allowed fields", () => {
        for (const access of [staging(), production()]) {
            checkPipeline(
                [
                    { $unwind: { path: "$items", includeArrayIndex: "position" } },
                    {
                        $addFields: {
                            lineTotal: { $multiply: ["$items.price", "$items.qty"] },
                            label: { $concat: ["$status", "-", { $toString: "$createdAt" }] },
                        },
                    },
                    {
                        $project: {
                            status: 1,
                            lineTotal: 1,
                            label: 1,
                            kind: { $cond: [{ $eq: ["$status", "open"] }, "o", "c"] },
                        },
                    },
                    { $sample: { size: 5 } },
                    { $skip: 1 },
                    {
                        $facet: {
                            byStatus: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
                            total: [{ $count: "n" }],
                        },
                    },
                ],
                ns,
                access,
            );
        }
    });

    test("$literal is not read as a reference, and the system variables are fine", () => {
        checkPipeline(
            [{ $addFields: { a: { $literal: "$password" }, b: "$$NOW", c: { $meta: "textScore" } } }],
            ns,
            staging(),
        );
    });

    test("variables of $map, $filter, $reduce and $let stand for the paths they were given", () => {
        checkPipeline(
            [
                {
                    $addFields: {
                        skus: { $map: { input: "$items", as: "line", in: "$$line.sku" } },
                        big: { $filter: { input: "$items", cond: { $gt: ["$$this.qty", 1] } } },
                        total: {
                            $reduce: { input: "$items", initialValue: 0, in: { $add: ["$$value", "$$this.qty"] } },
                        },
                        let: { $let: { vars: { s: "$status" }, in: { $concat: ["$$s", "!"] } } },
                    },
                },
            ],
            ns,
            production(),
        );
    });

    test("a made-up name can be used by the stages after it, even with an allow list", () => {
        checkPipeline(
            [
                { $project: { s: "$status" } },
                { $match: { s: "open" } },
                { $group: { _id: "$s", n: { $sum: 1 } } },
                { $match: { n: { $gt: 1 } } },
                { $sort: { n: -1 } },
            ],
            ns,
            production(),
        );
    });
});

describe("a pipeline: the ways to a denied field", () => {
    const bad = (pipeline: unknown[], pattern: RegExp, what: string, access: Access = staging()) =>
        refused(() => checkPipeline(pipeline, ns, access), pattern, what);

    test("a field named in a stage", () => {
        bad([{ $match: { password: 1 } }], /credential/, "$match");
        bad([{ $sort: { notes: 1 } }], /denied/, "$sort");
        bad([{ $project: { token: 1 } }], /credential/, "$project");
        bad([{ $unset: "notes" }], /denied/, "$unset");
        bad([{ $unwind: "$notes" }], /denied/, "$unwind");
        bad([{ $unwind: { path: "$items", includeArrayIndex: "token" } }], /credential/, "$unwind index name");
    });

    test("a rename: the value of a denied field copied under another name", () => {
        bad([{ $project: { x: "$password" } }], /credential/, "$project");
        bad([{ $addFields: { x: "$customer.apiKey" } }], /credential/, "$addFields");
        bad([{ $set: { x: "$notes" } }], /denied/, "$set");
        bad([{ $group: { _id: "$notes" } }], /denied/, "$group _id");
        bad([{ $group: { _id: null, all: { $push: "$password" } } }], /credential/, "$group accumulator");
        bad(
            [{ $addFields: { x: { $concat: ["a", { $toString: "$secretKey" }] } } }],
            /credential/,
            "nested in an expression",
        );
        bad([{ $addFields: { x: { $cond: [true, "$authToken", 0] } } }], /credential/, "in $cond");
        bad([{ $sortByCount: "$notes" }], /denied/, "$sortByCount");
        bad([{ $bucket: { groupBy: "$notes", boundaries: [0, 1] } }], /denied/, "$bucket");
        bad(
            [{ $setWindowFields: { partitionBy: "$notes", output: { n: { $sum: 1 } } } }],
            /denied/,
            "$setWindowFields",
        );
        bad([{ $redact: { $cond: [{ $eq: ["$notes", "a"] }, "$$PRUNE", "$$KEEP"] } }], /denied/, "$redact");
    });

    test("a name that looks denied is refused even as the name of a new field, so the model chooses another", () => {
        bad([{ $group: { _id: "$status", tokens: { $sum: 1 } } }], /credential.*choose another name/, "$group");
        bad([{ $addFields: { notes: 1 } }], /denied.*choose another name/, "$addFields");
        bad([{ $count: "passwordCount" }], /credential/, "$count");
    });

    test("$getField, with the name written out or computed", () => {
        bad([{ $addFields: { x: { $getField: "password" } } }], /credential/, "string form");
        bad([{ $addFields: { x: { $getField: { field: "notes", input: "$customer" } } } }], /denied/, "object form");
        bad(
            [{ $addFields: { x: { $getField: { field: { $literal: "apiKey" }, input: "$$ROOT" } } } }],
            /credential/,
            "$literal name",
        );
        bad(
            [{ $addFields: { x: { $getField: { field: { $concat: ["pass", "word"] } } } } }],
            /name written out/,
            "computed name",
        );
        bad(
            [{ $addFields: { x: { $getField: { field: "token", input: { $mergeObjects: ["$customer", {}] } } } } }],
            /credential/,
            "computed input",
        );
        bad(
            [{ $addFields: { x: { $setField: { field: { $concat: ["a", "b"] }, input: "$$ROOT", value: 1 } } } }],
            /name written out/,
            "$setField",
        );
        bad([{ $addFields: { x: { $unsetField: { field: "token", input: "$$ROOT" } } } }], /credential/, "$unsetField");
        checkPipeline([{ $addFields: { x: { $getField: { field: "status", input: "$$ROOT" } } } }], ns, production());
    });

    test("$objectToArray, which turns field names into values", () => {
        bad([{ $addFields: { x: { $objectToArray: "$customer" } } }], /\$objectToArray/, "deny list");
        bad([{ $project: { x: { $objectToArray: "$$ROOT" } } }], /\$objectToArray/, "root");
        bad([{ $project: { x: { $objectToArray: "$items" } } }], /\$objectToArray/, "allow list", production());
    });

    test("variables: a denied field through $map, $filter, $reduce, $let and a variable that is not defined", () => {
        bad([{ $addFields: { x: { $map: { input: "$items", as: "i", in: "$$i.token" } } } }], /credential/, "$map");
        bad(
            [{ $addFields: { x: { $filter: { input: "$items", cond: { $eq: ["$$this.notes", 1] } } } } }],
            /denied/,
            "$filter",
        );
        bad(
            [
                {
                    $addFields: {
                        x: {
                            $reduce: {
                                input: "$items",
                                initialValue: "",
                                in: { $concat: ["$$value", "$$this.password"] },
                            },
                        },
                    },
                },
            ],
            /credential/,
            "$reduce",
        );
        bad([{ $addFields: { x: { $let: { vars: { c: "$customer" }, in: "$$c.apiKey" } } } }], /credential/, "$let");
        bad(
            [{ $addFields: { x: { $let: { vars: { p: "$password" }, in: "$$p" } } } }],
            /credential/,
            "the value given to $let",
        );
        bad([{ $addFields: { x: "$$ROOT.password" } }], /credential/, "$$ROOT");
        bad([{ $addFields: { x: "$$nothing.a" } }], /unknown variable \$\$nothing/, "unknown");
        bad(
            [{ $addFields: { x: { $map: { input: [1], as: "i", in: "$$j" } } } }],
            /unknown variable \$\$j/,
            "out of scope",
        );
    });

    test("$lookup into a denied collection, and into an allowed one by a denied field", () => {
        bad(
            [
                {
                    $lookup: {
                        from: { db: "billing", coll: "cards" },
                        localField: "cardId",
                        foreignField: "_id",
                        as: "card",
                    },
                },
            ],
            /billing\.cards is denied/,
            "from a denied collection",
        );
        bad(
            [{ $lookup: { from: { db: "admin", coll: "users" }, localField: "a", foreignField: "b", as: "u" } }],
            /always denied/,
            "from a system database",
        );
        bad(
            [{ $lookup: { from: "system.profile", localField: "a", foreignField: "b", as: "u" } }],
            /system collections/,
            "from a system collection",
        );
        bad(
            [{ $lookup: { from: "customers", localField: "password", foreignField: "_id", as: "c" } }],
            /credential/,
            "local field",
        );
        bad(
            [{ $lookup: { from: "customers", localField: "a", foreignField: "token", as: "c" } }],
            /credential/,
            "foreign field",
        );
        bad(
            [{ $lookup: { from: "customers", localField: "a", foreignField: "_id", as: "token" } }],
            /credential/,
            "as",
        );
        bad([{ $lookup: { from: "customers", let: { p: "$password" }, pipeline: [], as: "c" } }], /credential/, "let");
        bad(
            [
                {
                    $lookup: {
                        from: "customers",
                        let: { n: "$status" },
                        pipeline: [{ $match: { $expr: { $eq: ["$notes", "$$n"] } } }],
                        as: "c",
                    },
                },
            ],
            /denied/,
            "inside the pipeline",
        );
        bad(
            [{ $lookup: { from: "customers", pipeline: [{ $match: { password: 1 } }], as: "c" } }],
            /credential/,
            "match inside the pipeline",
        );
        bad(
            [
                { $lookup: { from: "customers", localField: "a", foreignField: "_id", as: "c" } },
                { $addFields: { x: "$c.notes" } },
            ],
            /denied/,
            "the looked-up field, read later",
        );
        bad(
            [
                { $lookup: { from: "customers", localField: "a", foreignField: "_id", as: "c" } },
                { $project: { x: "$c.apiKey" } },
            ],
            /credential/,
            "a looked-up credential",
        );
        bad([{ $lookup: { as: "c" } }], /must name a collection/, "no from");
    });

    test("a field denied for one collection the pipeline reads is denied for all of them", () => {
        const access = deny("orders.customers.dob");
        refused(
            () =>
                checkPipeline(
                    [
                        { $lookup: { from: "customers", localField: "a", foreignField: "_id", as: "c" } },
                        { $match: { dob: 1 } },
                    ],
                    ns,
                    access,
                ),
            /denied/,
        );
    });

    test("$graphLookup into a denied collection, by a denied field, and in an allow list at all", () => {
        bad(
            [
                {
                    $graphLookup: {
                        from: { db: "billing", coll: "cards" },
                        startWith: "$a",
                        connectFromField: "a",
                        connectToField: "b",
                        as: "g",
                    },
                },
            ],
            /billing\.cards is denied/,
            "collection",
        );
        bad(
            [
                {
                    $graphLookup: {
                        from: "orders",
                        startWith: "$password",
                        connectFromField: "a",
                        connectToField: "b",
                        as: "g",
                    },
                },
            ],
            /credential/,
            "startWith",
        );
        bad(
            [
                {
                    $graphLookup: {
                        from: "orders",
                        startWith: "$a",
                        connectFromField: "token",
                        connectToField: "b",
                        as: "g",
                    },
                },
            ],
            /credential/,
            "connectFromField",
        );
        bad(
            [
                {
                    $graphLookup: {
                        from: "orders",
                        startWith: "$a",
                        connectFromField: "a",
                        connectToField: "notes",
                        as: "g",
                    },
                },
            ],
            /denied/,
            "connectToField",
        );
        bad(
            [
                {
                    $graphLookup: {
                        from: "orders",
                        startWith: "$a",
                        connectFromField: "a",
                        connectToField: "b",
                        as: "g",
                        restrictSearchWithMatch: { password: 1 },
                    },
                },
            ],
            /credential/,
            "restrictSearchWithMatch",
        );
        bad(
            [
                {
                    $graphLookup: {
                        from: "customers",
                        startWith: "$a",
                        connectFromField: "_id",
                        connectToField: "_id",
                        as: "g",
                    },
                },
            ],
            /\$graphLookup is not available with an allow list/,
            "allow list",
            production(),
        );
        checkPipeline(
            [
                {
                    $graphLookup: {
                        from: "orders",
                        startWith: "$a",
                        connectFromField: "a",
                        connectToField: "b",
                        as: "g",
                    },
                },
            ],
            ns,
            staging(),
        );
    });

    test("$facet: every sub-pipeline is walked, and so is the name of a facet", () => {
        bad(
            [{ $facet: { ok: [{ $count: "n" }], leak: [{ $project: { x: "$password" } }] } }],
            /credential/,
            "second branch",
        );
        bad([{ $facet: { a: [{ $match: { notes: 1 } }] } }], /denied/, "$match in a branch");
        bad(
            [
                {
                    $facet: {
                        a: [
                            {
                                $lookup: {
                                    from: { db: "billing", coll: "cards" },
                                    localField: "a",
                                    foreignField: "b",
                                    as: "c",
                                },
                            },
                        ],
                    },
                },
            ],
            /billing\.cards is denied/,
            "a lookup in a branch",
        );
        bad([{ $facet: { token: [{ $count: "n" }] } }], /credential/, "the facet's name");
        bad([{ $facet: {} }], /named pipelines/, "empty");
    });

    test("$unionWith: the collection, and the pipeline it runs", () => {
        bad(
            [{ $unionWith: { coll: "customers", pipeline: [{ $project: { x: "$password" } }] } }],
            /credential/,
            "the pipeline",
        );
        bad([{ $unionWith: { coll: "system.views" } }], /system collections/, "a system collection");
        bad([{ $unionWith: { coll: { db: "shop", coll: "orders" } } }], /same database/, "another database");
        bad(
            [{ $unionWith: { coll: { db: "billing", coll: "cards" } } }],
            /billing\.cards is denied/,
            "a denied collection in another database",
        );
        const access = deny("orders.cards");
        refused(() => checkPipeline([{ $unionWith: "cards" }], ns, access), /orders\.cards is denied/);
        refused(
            () =>
                checkPipeline(
                    [{ $unionWith: { coll: "payments", pipeline: [{ $match: { notes: 1 } }] } }],
                    ns,
                    staging(),
                ),
            /denied/,
        );
    });

    test("$replaceRoot and $replaceWith: a denied field as the new root, and a whole document that holds one", () => {
        bad([{ $replaceRoot: { newRoot: "$password" } }], /credential/, "$replaceRoot");
        bad([{ $replaceRoot: { newRoot: "$customer.apiKey" } }], /credential/, "$replaceRoot, deep");
        bad([{ $replaceRoot: { newRoot: { $mergeObjects: ["$a", "$notes"] } } }], /denied/, "$replaceRoot, computed");
        bad([{ $replaceWith: "$notes" }], /denied/, "$replaceWith");
        bad([{ $replaceRoot: { newRoot: "$profile" } }], /holds a denied field/, "a document that holds a denied path");
        bad(
            [{ $replaceWith: "$$ROOT" }],
            /holds a denied field|whole document/,
            "the whole document, while a denied path exists",
        );
        bad([{ $replaceRoot: {} }], /newRoot/, "no newRoot");
        checkPipeline([{ $replaceRoot: { newRoot: "$customer" } }, { $project: { name: 1 } }], ns, staging());
        checkPipeline([{ $replaceWith: "$$ROOT" }], ns, deny("*.notes"));
    });

    test("stages the walk does not know are refused, and the reason points to the action that does it", () => {
        bad([{ $collStats: {} }], /use the index-stats or stats action/, "$collStats");
        bad([{ $indexStats: {} }], /use the index-stats or stats action/, "$indexStats");
        bad([{ $search: {} }], /not supported/, "$search");
        bad([{ $currentOp: {} }], /not supported/, "$currentOp");
        bad([{ $geoNear: {} }], /not supported/, "$geoNear");
    });

    test("the shape of the pipeline and its stages", () => {
        refused(() => checkPipeline([], ns, staging()), /1 to 50 stages/);
        refused(() => checkPipeline("x" as never, ns, staging()), /1 to 50 stages/);
        refused(
            () =>
                checkPipeline(
                    Array.from({ length: 51 }, () => ({ $limit: 1 })),
                    ns,
                    staging(),
                ),
            /1 to 50 stages/,
        );
        refused(() => checkPipeline([{ $match: {}, $limit: 1 }], ns, staging()), /exactly one operator|one operator/);
        refused(() => checkPipeline([{ match: {} }], ns, staging()), /one operator/);
        refused(() => checkPipeline([5 as never], ns, staging()), /one operator/);
        refused(() => checkPipeline([{ $limit: 0 }], ns, staging()), /\$limit takes a whole number of 1 or more/);
        refused(() => checkPipeline([{ $skip: -1 }], ns, staging()), /\$skip/);
        refused(() => checkPipeline([{ $sample: {} }], ns, staging()), /\$sample size/);
        refused(() => checkPipeline([{ $sort: {} }], ns, staging()), /\$sort takes fields/);
        refused(() => checkPipeline([{ $sort: { a: 2 } }], ns, staging()), /must be 1 or -1/);
        refused(() => checkPipeline([{ $group: { n: { $sum: 1 } } }], ns, staging()), /needs an _id/);
        refused(() => checkPipeline([{ $count: "$n" }], ns, staging()), /\$count takes a field name/);
    });
});

describe("a pipeline with an allow list", () => {
    const bad = (pipeline: unknown[], pattern: RegExp, what: string, access: Access = production()) =>
        refused(() => checkPipeline(pipeline, ns, access), pattern, what);

    test("a field that is not listed is refused in every stage, in an expression, and in a sub-pipeline", () => {
        bad([{ $match: { internalNotes: 1 } }], /"internalNotes" is not allowed in orders\.orders/, "$match");
        bad([{ $project: { internalNotes: 1 } }], /not allowed/, "$project");
        bad([{ $sort: { internalNotes: 1 } }], /not allowed/, "$sort");
        bad([{ $group: { _id: "$internalNotes" } }], /not allowed/, "$group");
        bad([{ $addFields: { x: "$internalNotes" } }], /not allowed/, "$addFields");
        bad([{ $addFields: { x: { $add: ["$cost", 1] } } }], /"cost" is not allowed/, "an operator");
        bad(
            [
                {
                    $lookup: {
                        from: "customers",
                        let: { n: "$status" },
                        pipeline: [{ $match: { internalNotes: 1 } }],
                        as: "c",
                    },
                },
            ],
            /"internalNotes" is not allowed in orders\.customers/,
            "a lookup's pipeline is checked against its own collection",
        );
    });

    test("a new name does not hide a listed-field check in the same stage: every expression of a stage reads what came in", () => {
        bad(
            [{ $addFields: { internalNotes: 1, copy: "$internalNotes" } }],
            /"internalNotes" is not allowed/,
            "$addFields",
        );
        bad(
            [{ $project: { internalNotes: { $literal: 1 }, copy: "$internalNotes" } }],
            /"internalNotes" is not allowed/,
            "$project",
        );
    });

    test("the whole document is refused, as $$ROOT, $$CURRENT, a new root, or a variable that stands for it", () => {
        bad([{ $addFields: { x: "$$ROOT" } }], /whole document/, "$$ROOT");
        bad([{ $addFields: { x: "$$CURRENT" } }], /whole document/, "$$CURRENT");
        bad([{ $replaceWith: "$$ROOT" }], /whole document/, "$replaceWith");
        bad([{ $group: { _id: null, all: { $push: "$$ROOT" } } }], /whole document/, "$group");
        bad([{ $addFields: { x: { $let: { vars: { d: "$$ROOT" }, in: "$$d" } } } }], /whole document/, "$let");
        checkPipeline([{ $addFields: { x: "$$ROOT.status" } }], ns, production());
    });

    test("a field that is listed only in part cannot be copied, compared or sorted whole; it can be unwound or kept", () => {
        const partial = allow({ "orders.orders": ["_id", "items.sku"] });
        bad([{ $addFields: { x: "$items" } }], /only partly allowed/, "an expression", partial);
        bad([{ $unwind: "$items" }, { $group: { _id: "$items" } }], /only partly allowed/, "after $unwind", partial);
        bad([{ $sort: { items: 1 } }], /only partly allowed/, "$sort", partial);
        bad([{ $match: { items: { $gt: { sku: "a" } } } }], /only partly allowed/, "$match", partial);
        checkPipeline([{ $unwind: "$items" }, { $group: { _id: "$items.sku", n: { $sum: 1 } } }], ns, partial);
        // The projection in front already left only the allowed part of `items`.
        checkPipeline([{ $project: { items: 1 } }, { $unset: "items" }], ns, partial);
    });

    test("a projection of the allowed fields is put in front, after the leading $match stages", () => {
        const checked = checkPipeline(
            [
                { $match: { status: "open" } },
                { $match: { createdAt: { $gt: 1 } } },
                { $sort: { createdAt: -1 } },
                { $limit: 5 },
            ],
            ns,
            production(),
        );
        assert.deepEqual(checked.stages, [
            { $match: { status: "open" } },
            { $match: { createdAt: { $gt: 1 } } },
            { $project: { _id: 1, status: 1, items: 1, createdAt: 1 } },
            { $sort: { createdAt: -1 } },
            { $limit: 5 },
        ]);
        assert.deepEqual(checkPipeline([{ $group: { _id: "$status" } }], ns, production()).stages[0], {
            $project: { _id: 1, status: 1, items: 1, createdAt: 1 },
        });
    });

    test("$lookup reads only the allowed fields of the collection it joins: the simple form gets a pipeline, the pipeline form a projection first", () => {
        const [simple] = checkPipeline(
            [{ $lookup: { from: "customers", localField: "status", foreignField: "_id", as: "customer" } }],
            ns,
            production(),
        ).stages.slice(1);
        assert.deepEqual(simple, {
            $lookup: {
                from: "customers",
                localField: "status",
                foreignField: "_id",
                as: "customer",
                pipeline: [{ $project: { _id: 1, name: 1 } }],
            },
        });
        const [piped] = checkPipeline(
            [
                {
                    $lookup: {
                        from: "customers",
                        let: { s: "$status" },
                        pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$s"] } } }, { $limit: 1 }],
                        as: "customer",
                    },
                },
            ],
            ns,
            production(),
        ).stages.slice(1);
        assert.deepEqual((piped as any).$lookup.pipeline, [
            { $match: { $expr: { $eq: ["$_id", "$$s"] } } },
            { $project: { _id: 1, name: 1 } },
            { $limit: 1 },
        ]);
        bad(
            [{ $lookup: { from: "payments", localField: "a", foreignField: "b", as: "p" } }],
            /orders\.payments is not in the allow list/,
            "a collection that is not listed",
        );
        checkPipeline(
            [
                { $lookup: { from: "customers", localField: "status", foreignField: "_id", as: "customer" } },
                { $match: { "customer.name": "Ada" } },
            ],
            ns,
            production(),
        );
    });

    test("$unionWith reads only the allowed fields of its collection", () => {
        const [, union] = checkPipeline([{ $unionWith: "customers" }], ns, production()).stages;
        assert.deepEqual(union, { $unionWith: { coll: "customers", pipeline: [{ $project: { _id: 1, name: 1 } }] } });
        bad([{ $unionWith: "payments" }], /not in the allow list/, "not listed");
        bad(
            [{ $unionWith: { coll: "customers", pipeline: [{ $project: { password: 1 } }] } }],
            /credential/,
            "a credential in its pipeline",
        );
    });

    test("$facet branches see the stream that was already limited, and are checked", () => {
        const checked = checkPipeline([{ $facet: { a: [{ $count: "n" }] } }], ns, production());
        assert.deepEqual(checked.stages[0], { $project: { _id: 1, status: 1, items: 1, createdAt: 1 } });
        bad([{ $facet: { a: [{ $match: { internalNotes: 1 } }] } }], /not allowed/, "a branch");
    });
});

describe("a pipeline that writes", () => {
    test("$out and $merge as the last stage make it a write to a collection, which is checked like any other", () => {
        const out = checkPipeline([{ $match: { status: "open" } }, { $out: "archive" }], ns, staging());
        assert.deepEqual(out.output, {
            stage: "$out",
            target: { db: "orders", coll: "archive" },
            doc: { $out: "archive" },
        });
        assert.deepEqual(
            out.stages,
            [{ $match: { status: "open" } }],
            "the output stage is not among the stages to run first",
        );
        const merge = checkPipeline(
            [{ $merge: { into: { db: "reports", coll: "daily" }, on: "_id", whenMatched: "replace" } }],
            ns,
            staging(),
        );
        assert.deepEqual(merge.output?.target, { db: "reports", coll: "daily" });
        assert.equal(
            checkPipeline([{ $out: { db: "reports", coll: "daily" } }], ns, staging()).output?.target.db,
            "reports",
        );
    });

    test("the target may not be a denied collection, a system database, or a collection outside the allow list", () => {
        refused(
            () => checkPipeline([{ $out: { db: "billing", coll: "cards" } }], ns, staging()),
            /billing\.cards is denied/,
        );
        refused(() => checkPipeline([{ $out: { db: "admin", coll: "x" } }], ns, staging()), /always denied/);
        refused(() => checkPipeline([{ $merge: { into: "system.views" } }], ns, staging()), /system collections/);
        refused(
            () => checkPipeline([{ $out: "archive" }], ns, production()),
            /orders\.archive is not in the allow list/,
        );
        refused(() => checkPipeline([{ $out: 5 as never }], ns, staging()), /\$out must name a collection/);
        refused(() => checkPipeline([{ $merge: {} }], ns, staging()), /\$merge into must name a collection/);
    });

    test("not last, or inside a sub-pipeline, it is refused; the stages before it are still checked", () => {
        refused(
            () => checkPipeline([{ $out: "archive" }, { $limit: 1 }], ns, staging()),
            /\$out must be the last stage/,
        );
        refused(
            () => checkPipeline([{ $facet: { a: [{ $out: "x" }] } }], ns, staging()),
            /must be the last stage of the pipeline and cannot be inside a sub-pipeline/,
        );
        refused(() => checkPipeline([{ $match: { password: 1 } }, { $out: "archive" }], ns, staging()), /credential/);
        refused(() => checkPipeline([{ $merge: { into: "archive", on: "token" } }], ns, staging()), /credential/);
        refused(
            () => checkPipeline([{ $merge: { into: "archive", whenMatched: [{ $match: {} }] } }], ns, staging()),
            /whenMatched can use/,
        );
        refused(
            () =>
                checkPipeline(
                    [{ $merge: { into: "archive", whenMatched: [{ $addFields: { x: "$password" } }] } }],
                    ns,
                    staging(),
                ),
            /credential/,
        );
        checkPipeline(
            [
                {
                    $merge: {
                        into: "archive",
                        whenMatched: [{ $addFields: { total: { $add: ["$total", "$$new.total"] } } }],
                    },
                },
            ],
            ns,
            staging(),
        );
    });
});

describe("an update written as stages", () => {
    test("only the stages that update are allowed, and their references are checked", () => {
        checkUpdatePipeline([{ $set: { total: { $add: ["$a", 1] } } }, { $unset: "old" }], ns, staging());
        refused(() => checkUpdatePipeline([{ $match: {} }], ns, staging()), /an update pipeline can use/);
        refused(() => checkUpdatePipeline([{ $set: { x: "$password" } }], ns, staging()), /credential/);
        refused(() => checkUpdatePipeline([{ $set: { x: "$internalNotes" } }], ns, production()), /not allowed/);
        refused(() => checkUpdatePipeline([], ns, staging()), /1 to 50 stages/);
    });
});

describe("JavaScript", () => {
    const places: Array<[string, unknown]> = [
        ["a filter", { $where: "this.a == 1" }],
        ["a nested filter", { $or: [{ $where: "true" }] }],
        ["an expression", [{ $addFields: { x: { $function: { body: "function(){}", args: [], lang: "js" } } } }]],
        [
            "an accumulator",
            [
                {
                    $group: {
                        _id: null,
                        x: {
                            $accumulator: {
                                init: "function(){}",
                                accumulate: "function(){}",
                                accumulateArgs: [],
                                merge: "function(){}",
                                lang: "js",
                            },
                        },
                    },
                },
            ],
        ],
        ["a code value", { a: { $code: "x" } }],
        ["a code value with a scope", { a: { $code: "x", $scope: {} } }],
        ["a document to write", { documents: [{ $function: 1 }] }],
    ];

    test("is refused wherever it is written, with the operator named", () => {
        for (const [what, value] of places) {
            assert.throws(
                () => scanJavaScript(value, false),
                (error: unknown) =>
                    error instanceof InputError &&
                    /runs JavaScript on the server, which is not allowed here/.test(error.message),
                what,
            );
        }
        assert.throws(() => scanJavaScript({ a: [{ b: { $where: "x" } }] }, false), /\$where/);
    });

    test("is let through only when the environment allows it, and its arguments are still checked", () => {
        for (const [, value] of places) scanJavaScript(value, true);
        refused(
            () =>
                checkPipeline(
                    [
                        {
                            $addFields: {
                                x: { $function: { body: "function(a){return a}", args: ["$password"], lang: "js" } },
                            },
                        },
                    ],
                    ns,
                    staging(),
                ),
            /credential/,
        );
        checkPipeline(
            [{ $addFields: { x: { $function: { body: "function(a){return a}", args: ["$status"], lang: "js" } } } }],
            ns,
            staging(),
        );
    });

    test("a value that only looks like code is not refused", () => {
        scanJavaScript({ note: "the $where operator", list: ["$function"] }, false);
    });
});
