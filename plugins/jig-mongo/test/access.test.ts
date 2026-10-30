// What the agent may see: the deny list and the allow list, reaching fields; and the three things no list can change.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ObjectId } from "mongodb";
import { createAccess, fieldPath, projectionFor, readAllow, readDeny, stripCredentials } from "../src/access.ts";
import type { Access, AccessRules } from "../src/access.ts";
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

const refused = (run: () => unknown, pattern: RegExp) =>
    assert.throws(run, (error: unknown) => error instanceof InputError && pattern.test(error.message));

describe("reading a deny list", () => {
    test("accepts the four shapes of pattern", () => {
        const errors: string[] = [];
        const rules = readDeny(
            ["billing.cards", "payments.*", "*.notes", "orders.orders.internal.cost", "*.profile.ssn"],
            "deny",
            errors,
        );
        assert.deepEqual(errors, []);
        assert.ok(rules?.collections.has("billing.cards"));
        assert.ok(rules?.databases.has("payments"));
        assert.deepEqual(
            rules?.fields.map((field) => [field.db, field.coll, field.path.join(".")]),
            [
                [undefined, undefined, "notes"],
                ["orders", "orders", "internal.cost"],
                [undefined, undefined, "profile.ssn"],
            ],
        );
    });

    test("a pattern of three or more parts is also the collection of that name: a collection name may hold dots", () => {
        const rules = readDeny(["shop.orders.archive"], "deny", []);
        assert.ok(rules?.collections.has("shop.orders.archive"));
        assert.equal(rules?.fields.length, 1);
    });

    test("refuses what is none of them, and names the key", () => {
        for (const bad of ["notes", "*", "*.", ".notes", "orders..x", "*.a*b", "bad db.x", 5, ""]) {
            const errors: string[] = [];
            assert.equal(readDeny([bad], "mongo.access.staging.deny", errors), undefined, String(bad));
            assert.match(errors[0] ?? "", /^mongo\.access\.staging\.deny:/);
        }
        const errors: string[] = [];
        readDeny("orders.orders", "deny", errors);
        assert.match(errors[0] ?? "", /must be a list/);
    });
});

describe("reading an allow list", () => {
    test("maps collections to field paths", () => {
        const errors: string[] = [];
        const rules = readAllow({ "orders.orders": ["_id", "items.sku"], "shop.fs.files": ["_id"] }, "allow", errors);
        assert.deepEqual(errors, []);
        assert.deepEqual(rules?.get("orders.orders"), [["_id"], ["items", "sku"]]);
        // The first dot ends the database name: the collection may hold more dots.
        assert.deepEqual(rules?.get("shop.fs.files"), [["_id"]]);
    });

    test("refuses an empty list, a bad key, a bad field, and a credential-like field, which can never be allowed", () => {
        const cases: Array<[unknown, RegExp]> = [
            [{}, /1 to 200 collections/],
            [{ orders: ["a"] }, /not "db.collection"/],
            [{ "orders.orders": [] }, /1 to 500 field paths/],
            [{ "orders.orders": [""] }, /not a field path/],
            [{ "orders.orders": ["$set"] }, /not a field path/],
            [{ "orders.orders": ["owner.Password"] }, /always denied/],
            [{ "orders.orders": ["apiKey"] }, /always denied/],
            [{ "orders.orders": ["sessionToken"] }, /always denied/],
            [{ "orders.orders": ["clientSecret"] }, /always denied/],
        ];
        for (const [raw, pattern] of cases) {
            const errors: string[] = [];
            assert.equal(readAllow(raw, "allow", errors), undefined, JSON.stringify(raw));
            assert.match(errors.join(" "), pattern);
        }
    });
});

describe("databases and collections", () => {
    test("admin, local and config are denied in every environment, in any letter case", () => {
        for (const access of [deny(), allow({ "orders.orders": ["_id"] })]) {
            for (const db of ["admin", "local", "config", "ADMIN", "Config"]) {
                refused(() => access.namespace(db), /always denied/);
                refused(() => access.namespace(db, "users"), /always denied/);
                assert.equal(access.namespaceVisible(db), false);
            }
        }
    });

    test("system collections are denied everywhere", () => {
        for (const access of [deny(), allow({ "orders.system.views": ["_id"] })]) {
            refused(() => access.namespace("orders", "system.profile"), /system collections are always denied/);
            refused(() => access.namespace("orders", "System.users"), /system collections/);
        }
    });

    test("a deny list hides what it lists and nothing else", () => {
        const access = deny("billing.cards", "payments.*");
        refused(() => access.namespace("billing", "cards"), /billing\.cards is denied/);
        refused(() => access.namespace("payments", "refunds"), /payments\.refunds is denied/);
        refused(() => access.namespace("payments"), /payments is denied/);
        access.namespace("billing", "invoices");
        access.namespace("orders", "orders");
        assert.equal(access.namespaceVisible("billing"), true);
        assert.equal(access.namespaceVisible("billing", "cards"), false);
    });

    test("an allow list shows only what it lists, and says what is allowed", () => {
        const access = allow({ "orders.orders": ["_id"], "orders.customers": ["_id"] });
        access.namespace("orders", "orders");
        refused(
            () => access.namespace("orders", "payments"),
            /orders\.payments is not in the allow list; allowed: orders\.orders, orders\.customers/,
        );
        refused(() => access.namespace("shop"), /not in the allow list/);
        assert.equal(access.namespaceVisible("orders"), true);
        assert.equal(access.namespaceVisible("shop"), false);
        assert.deepEqual(access.listed("orders"), ["orders", "customers"]);
    });

    test("an allow list that is empty says nothing is allowed yet", () => {
        const empty = createAccess({ mode: "allow", allow: new Map(), javascript: false });
        refused(() => empty.namespace("orders", "orders"), /nothing is allowed yet/);
    });
});

describe("fields: the names that are always denied", () => {
    test("password, secret, token and apiKey in any case, anywhere in a path", () => {
        const view = deny().view([ns]);
        for (const name of [
            "password",
            "Password",
            "userPASSWORD",
            "clientSecret",
            "secretKey",
            "authToken",
            "tokens",
            "apiKey",
            "APIKEY",
            "api_apikey",
        ]) {
            assert.equal(view.visibility([name]), "no", name);
            assert.equal(view.visibility(["customer", name]), "no", name);
            assert.equal(view.visibility([name, "x"]), "no", name);
            assert.equal(view.nameDenied(name), true);
        }
        assert.equal(view.visibility(["status"]), "yes");
        assert.equal(view.visibility(["customer", "name"]), "yes");
        assert.match(view.reason(["customer", "authToken"]), /"authToken" looks like a credential/);
    });

    test("an allow list cannot allow one either: the path is refused even under an allowed field", () => {
        const view = allow({ "orders.orders": ["items"] }).view([ns]);
        assert.equal(view.visibility(["items", "sku"]), "yes");
        assert.equal(view.visibility(["items", "token"]), "no");
    });
});

describe("fields: a deny list", () => {
    test("*.field applies to every collection, db.collection.field to one", () => {
        const access = deny("*.notes", "orders.orders.internal");
        assert.equal(access.view([ns]).visibility(["notes"]), "no");
        assert.equal(access.view([ns]).visibility(["internal"]), "no");
        assert.equal(access.view([{ db: "orders", coll: "customers" }]).visibility(["notes"]), "no");
        assert.equal(access.view([{ db: "orders", coll: "customers" }]).visibility(["internal"]), "yes");
        assert.equal(access.view([{ db: "shop", coll: "orders" }]).visibility(["internal"]), "yes");
    });

    test("a denied name is denied at any depth, and so is a denied dotted path", () => {
        const view = deny("*.notes", "*.profile.ssn").view([ns]);
        assert.equal(view.visibility(["a", "b", "notes"]), "no");
        assert.equal(view.visibility(["customer", "profile", "ssn"]), "no");
        assert.equal(view.visibility(["profile", "ssn", "last4"]), "no");
        assert.equal(view.visibility(["profile", "name"]), "yes");
        assert.equal(view.visibility(["ssn"]), "yes");
    });

    test("a field that holds a denied one is partial: a whole document could be copied out under another name", () => {
        const view = deny("*.profile.ssn").view([ns]);
        assert.equal(view.visibility(["profile"]), "partial");
        assert.equal(view.visibility(["customer", "profile"]), "partial");
        assert.equal(view.visibility([]), "partial");
        assert.equal(view.visibility(["status"]), "yes");
        assert.match(view.reason(["profile"]), /holds a denied field/);
    });

    test("a pattern given by a name alone is a name denied wherever it appears", () => {
        const view = deny("*.notes").view([ns]);
        assert.equal(view.nameDenied("notes"), true);
        assert.equal(view.nameDenied("note"), false);
        assert.equal(deny("*.profile.ssn").view([ns]).nameDenied("ssn"), false);
    });

    test("several collections give one view that denies what any of them denies", () => {
        const access = deny("orders.orders.cost", "orders.customers.dob");
        const view = access.view([ns, { db: "orders", coll: "customers" }]);
        assert.equal(view.visibility(["cost"]), "no");
        assert.equal(view.visibility(["dob"]), "no");
    });
});

describe("fields: an allow list", () => {
    const view = allow({ "orders.orders": ["_id", "status", "items.sku", "createdAt"] }).view([ns]);

    test("a listed field and what is under it are visible, a field that holds only listed ones is partial, the rest is not", () => {
        assert.equal(view.visibility(["status"]), "yes");
        assert.equal(view.visibility(["status", "code"]), "yes");
        assert.equal(view.visibility(["items", "sku"]), "yes");
        assert.equal(view.visibility(["items"]), "partial");
        assert.equal(view.visibility([]), "partial");
        assert.equal(view.visibility(["items", "price"]), "no");
        assert.equal(view.visibility(["internalNotes"]), "no");
    });

    test("the reason names the allowed fields", () => {
        assert.match(
            view.reason(["internalNotes"]),
            /"internalNotes" is not allowed in orders\.orders; allowed: _id, status, items\.sku, createdAt/,
        );
        assert.match(view.reason(["items"]), /only partly allowed/);
    });
});

describe("stripping a result", () => {
    test("denied fields come out at any depth, through arrays, and typed values are left whole", () => {
        const view = deny("*.notes", "*.profile.ssn").view([ns]);
        const id = new ObjectId("65f1f1f1f1f1f1f1f1f1f1f1");
        const doc = {
            _id: id,
            status: "open",
            notes: "private",
            password: "p",
            customer: { name: "Ada", profile: { ssn: "123", city: "X" }, apiKey: "k" },
            items: [{ sku: "a", notes: "n", nested: [{ token: "t", ok: 1 }] }],
            when: new Date(0),
        };
        assert.deepEqual(view.strip(doc), {
            _id: id,
            status: "open",
            customer: { name: "Ada", profile: { city: "X" } },
            items: [{ sku: "a", nested: [{ ok: 1 }] }],
            when: new Date(0),
        });
    });

    test("a document that is not a document passes through", () => {
        const view = deny().view([ns]);
        assert.equal(view.strip("text"), "text");
        assert.equal(view.strip(null), null);
        assert.deepEqual(view.strip([1, { password: 1, a: 2 }]), [1, { a: 2 }]);
    });

    test("with an allow list only the allowed fields remain, and a key named __proto__ stays harmless", () => {
        const view = allow({ "orders.orders": ["_id", "status", "items.sku"] }).view([ns]);
        const doc = JSON.parse(
            '{"_id": 1, "status": "x", "secretStuff": 1, "items": [{"sku": "a", "price": 5}], "other": 2, "__proto__": {"x": 1}}',
        );
        const stripped = view.strip(doc) as Record<string, unknown>;
        assert.deepEqual(stripped, { _id: 1, status: "x", items: [{ sku: "a" }] });
        assert.equal(Object.getPrototypeOf(stripped), Object.prototype);
    });

    test("the base path places a value that is not a whole document", () => {
        const view = allow({ "orders.orders": ["items.sku"] }).view([ns]);
        assert.deepEqual(view.strip([{ sku: "a", price: 1 }], ["items"]), [{ sku: "a" }]);
    });

    test("credential-like fields alone can be stripped from a document of unknown shape", () => {
        assert.deepEqual(stripCredentials({ total: 5, userPassword: "x", nested: [{ apiKey: 1, n: 2 }] }), {
            total: 5,
            nested: [{ n: 2 }],
        });
    });
});

describe("the projection of a find", () => {
    test("a deny list leaves the projection as asked", () => {
        assert.deepEqual(projectionFor(deny(), ns, { status: 1 }), { status: 1 });
        assert.equal(projectionFor(deny(), ns, undefined), undefined);
    });

    test("an allow list forces an inclusion projection of the allowed fields, _id included only when allowed", () => {
        const access = allow({ "orders.orders": ["status", "items.sku"] });
        assert.deepEqual(projectionFor(access, ns, undefined), { status: 1, "items.sku": 1, _id: 0 });
        const withId = allow({ "orders.orders": ["_id", "status"] });
        assert.deepEqual(projectionFor(withId, ns, undefined), { _id: 1, status: 1 });
        assert.deepEqual(projectionFor(withId, ns, { status: 1, _id: 0 }), { status: 1, _id: 0 });
    });

    test("a requested field must be allowed; a partly allowed one expands to the allowed fields under it", () => {
        const access = allow({ "orders.orders": ["_id", "status", "items.sku", "items.qty"] });
        // `_id` comes with an inclusion projection, and it is allowed here.
        assert.deepEqual(projectionFor(access, ns, { status: 1 }), { status: 1 });
        assert.deepEqual(projectionFor(access, ns, { items: 1 }), { "items.sku": 1, "items.qty": 1 });
        refused(
            () => projectionFor(access, ns, { internalNotes: 1 }),
            /"internalNotes" is not allowed in orders\.orders/,
        );
        refused(() => projectionFor(access, ns, { password: 1 }), /always denied/);
    });

    test("excluding fields is refused: it would return everything else", () => {
        const access = allow({ "orders.orders": ["_id", "status"] });
        refused(() => projectionFor(access, ns, { status: 0 }), /name the fields you want/);
        refused(() => projectionFor(allow({ "orders.orders": ["_id"] }), ns, { _id: 0 }), /no field that may be read/);
    });

    test("a field and one of its children together are one path, so the projection has no collision", () => {
        const access = allow({ "orders.orders": ["items", "items.sku"] });
        assert.deepEqual(projectionFor(access, ns, undefined), { items: 1, _id: 0 });
    });
});

describe("field paths", () => {
    test("array positions and positional operators are not fields", () => {
        assert.deepEqual(fieldPath("items.0.sku"), ["items", "sku"]);
        assert.deepEqual(fieldPath("items.$.sku"), ["items", "sku"]);
        assert.deepEqual(fieldPath("items.$[].sku"), ["items", "sku"]);
        assert.deepEqual(fieldPath("items.$[line].sku"), ["items", "sku"]);
        assert.deepEqual(fieldPath("a.b"), ["a", "b"]);
    });
});
