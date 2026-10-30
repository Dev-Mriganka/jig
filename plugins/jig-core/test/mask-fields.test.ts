// Field-name rules, the token format, and the field names a company plugin adds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createMasker } from "../src/mask/index.ts";
import { fieldKind } from "../src/mask/kinds.ts";
import { assertFailsClosed, assertWithheld, maskText, maskValue, masker, occurrences } from "./mask-support.ts";

describe("token format", () => {
    it("is HMAC-SHA256(key, label NUL value), first 3 bytes in hex", () => {
        // Known answers: a change to the construction would make every token differ from what it was.
        assert.deepEqual(maskValue({ email: "digest-vector@example.invalid" }, 66), { email: "email#d1be5e" });
        assert.deepEqual(maskValue({ email: "person@example.com" }, 7), { email: "email#285c6d" });
    });

    it("changes with the key", () => {
        const first = maskValue({ email: "person@example.com" }, 7);
        const next = maskValue({ email: "person@example.com" }, 8);
        assert.equal(first.email, "email#285c6d");
        assert.notEqual(first.email, next.email);
    });

    it("rejects a key too short to protect tokens", () => {
        assertFailsClosed(() => createMasker(new Uint8Array(8)));
        assertFailsClosed(() => createMasker(new Uint8Array(0)));
        assert.doesNotThrow(() => createMasker(new Uint8Array(16)));
    });
});

describe("field-name corpus", () => {
    const rows = JSON.parse(readFileSync(new URL("./mask-corpus/field-names.json", import.meta.url), "utf8")) as
        { field: string; sensitive: boolean; value: unknown }[];

    it("has 51 rows", () => assert.equal(rows.length, 51));

    for (const row of rows) {
        it(`${row.field}: ${row.sensitive ? "sensitive" : "kept"}`, () => {
            const kind = fieldKind(row.field, "");
            assert.equal(!["safe", "identifier", "other"].includes(kind), row.sensitive);
            const input = { [row.field]: row.value };
            assert.equal(JSON.stringify(maskValue(input)) !== JSON.stringify(input), row.sensitive);
        });
    }
});

describe("field rules", () => {
    it("does not treat numeric token units as credentials", () => {
        const result = maskValue({
            input_count: 42, tokens_used: 3, available_tokens_estimate: 123, context_estimate: 123,
            refresh_token: "secret", access_token: "secret", api_key: "secret", input_tokens: "secret",
            token: 123, password_tokens: 123, api_key_tokens: 123,
        });
        assert.equal(result.input_tokens, "[removed:credential]");
        assert.equal(result.tokens_used, 3);
        assert.equal(result.available_tokens_estimate, 123);
        assert.equal(result.context_estimate, 123);
        for (const key of ["token", "refresh_token", "access_token", "api_key", "password_tokens", "api_key_tokens"]) {
            assert.equal(result[key], "[removed:credential]", key);
        }
        assert.equal(maskValue({ input_tokens: 42 }).input_tokens, 42);
    });

    it("covers common field aliases and nested values", () => {
        for (const [key, value, tag] of [
            ["ip_address", "192.0.2.3", "ip#"],
            ["credentials", { arbitrary: "hidden" }, "[removed:credential]"],
            ["coordinates", [12.34567, 45.6789], "[removed:geo]"],
            ["governmentId", "synthetic-id", "[removed:government]"],
            ["driverLicence", "synthetic-licence", "[removed:government]"],
        ] as const) {
            const masked = maskValue({ [key]: value });
            assert.ok(String(masked[key]).startsWith(tag), key);
        }
    });

    it("applies field precedence, and removes an address whole", () => {
        const masked = maskValue({
            emailAddress: "person@example.com",
            macAddress: "02:00:00:00:00:01",
            shippingAddress: { street: "4 Test Lane", state: "NJ", country: "US" },
            licenseState: "CA",
            orderId: "ord-12",
        }, 1);
        assert.ok(String(masked.emailAddress).startsWith("email#"));
        assert.equal(masked.macAddress, "02:00:00:00:00:01"); // a device identifier is an id
        assert.equal(masked.shippingAddress, "[removed:address]"); // not even the state or country is kept
        assert.equal(masked.licenseState, "CA");
        assert.equal(masked.orderId, "ord-12");
    });

    it("masks numeric and nested sensitive values", () => {
        const masked = maskValue({
            phone: 2025550123, cardNumber: 4111111111111111, imei: 123456789012345, // an imei is an id
            password: { nested: "secret-value" }, firstName: { display: "Taylor" },
            healthNote: ["private-note"], bank: { account: 123456789 },
        }, 2);
        const text = JSON.stringify(masked);
        for (const leaked of ["secret-value", "private-note"]) assert.ok(!text.includes(leaked), leaked);
        assert.equal(masked.password, "[removed:credential]");
        assert.equal(masked.healthNote, "[removed:sensitive]");
        assert.equal(masked.bank.account, "[removed:bank]");
        assert.ok(masked.phone.startsWith("phone#"));
        assert.equal(masked.cardNumber, "card ****1111");
        assert.equal(masked.imei, 123456789012345);
        assert.ok(masked.firstName.display.startsWith("name#"));
    });

    it("applies field rules to log and URL encodings", () => {
        const value = maskText(
            "WARN password=abc123 routingNumber=000000000 version=1.2.3.4 orderId=ord-44 GET /?pass%77ord=hidden&tn=%252B442079460958",
            4,
        );
        for (const leaked of ["abc123", "000000000", "hidden", "%252B442079460958"]) assert.ok(!value.includes(leaked), leaked);
        assert.ok(value.includes("version=1.2.3.4"));
        assert.ok(value.includes("orderId=ord-44"));
        assert.ok(value.includes("0958"));
        assert.ok(value.includes("[removed:credential]"));
        assert.ok(value.includes("phone#"));
        assertWithheld(() => maskText("GET /?pass%2577ord=secret%2525252521", 4));
    });

    it("masks non-US phones and IPv6 literals", () => {
        const value = maskText("call +442079460958 src=::1 peer=::ffff:192.0.2.1", 5);
        for (const leaked of ["+442079460958", "::ffff:192.0.2.1"]) assert.ok(!value.includes(leaked), leaked);
        assert.ok(value.includes("src=::1"), "loopback is internal and stays readable");
        assert.ok(value.includes("0958"));
        assert.equal(occurrences(value, "phone#"), 1);
        assert.equal(occurrences(value, "ip#"), 1);
    });

    it("gives one phone one token across formats and records", () => {
        const value = maskValue({
            contactPhone: "(202) 555-0123 ext. 99",
            usage: [{ from: "+12025550123", to: "202-555-0123" }],
        }, 1);
        assert.equal(value.contactPhone, value.usage[0].from);
        assert.equal(value.contactPhone, value.usage[0].to);
        assert.ok(value.contactPhone.endsWith("-0123"));
    });

    it("keeps versions around embedded JSON and queries", () => {
        const value = maskText('INFO payload={"version":"1.2.3.4","email":"x@example.com"} GET /?version=1.2.3.4&phone=%2B12025550123');
        assert.equal(occurrences(value, "1.2.3.4"), 2);
        assert.ok(!value.includes("x@example.com"));
        assert.ok(!value.includes("%2B12025550123"));
        assert.equal(occurrences(value, "email#"), 1);
        assert.equal(occurrences(value, "phone#"), 1);
    });

    it("classifies doubly escaped JSON fields", () => {
        const value = maskText('WARN payload={\\"password\\":\\"fake-passphrase\\",\\"orderId\\":\\"ord-12\\"}', 8);
        assert.ok(!value.includes("fake-passphrase"));
        assert.ok(value.includes("ord-12"));
        assert.equal(occurrences(value, "[removed:credential]"), 1);
    });
});

describe("bare name fields inside things", () => {
    it("keeps the names of plans, charges, triggers and products; masks people's names", () => {
        const text = JSON.stringify(maskValue({
            plans: [{ name: "Standard Plan", sku: "PLAN-001", charges: [{ name: "Per Unit Charge", price: "14.98" }] }],
            triggers: [{ name: "ContractEffective", triggerDate: "2026-09-21" }],
            products: [{ name: "Standard Pricebook" }],
            contact: { name: "Jane Customer", firstName: "Jane" },
            users: [{ name: "John Customer" }],
        }));
        for (const kept of ["Standard Plan", "Per Unit Charge", "ContractEffective", "Standard Pricebook"]) assert.ok(text.includes(kept), kept);
        for (const masked of ["Jane Customer", "John Customer", "\"Jane\""]) assert.ok(!text.includes(masked), masked);
    });
});

describe("fields a company plugin adds", () => {
    const options = { extraFields: ["subscriberAlias", "contact_ref"] };

    it("tokenises the value of a named field, whatever the case or separators of its spelling", () => {
        const out = maskValue({
            subscriberAlias: "Bobby", subscriber_alias: "Bobby", "SUBSCRIBER-ALIAS": "Bobby", contactRef: "c-42", orderId: "ord-1",
        }, 7, options);
        for (const key of ["subscriberAlias", "subscriber_alias", "SUBSCRIBER-ALIAS", "contactRef"]) {
            assert.match(out[key], /^personal#[0-9a-f]{6}$/, key);
        }
        assert.equal(out.subscriberAlias, out.subscriber_alias, "one value, one token");
        assert.notEqual(out.subscriberAlias, out.contactRef);
        assert.equal(out.orderId, "ord-1");
    });

    it("reaches numbers, nested values, dotted keys, log fields, embedded JSON and query strings", () => {
        const out = maskValue({
            subscriberAlias: { display: "Bobby", id: 5 },
            "customer.contact_ref": "c-42",
            list: [{ contactRef: 987654 }],
        }, 7, options);
        assert.match(out.subscriberAlias.display, /^personal#/);
        assert.equal(out.subscriberAlias.id, 5, "an identifier inside keeps its own rule");
        assert.match(out["customer.contact_ref"], /^personal#/);
        assert.match(out.list[0].contactRef, /^personal#/);

        const text = masker(7, options).text('INFO subscriber_alias=Bobby GET /x?contactRef=c-42&orderId=o-1 payload={"subscriberAlias":"Bobby"}');
        assert.ok(!text.includes("Bobby") && !text.includes("c-42"), text);
        assert.equal(occurrences(text, "personal#"), 3);
        assert.ok(text.includes("orderId=o-1"));
    });

    it("wins over the built-in rules, because an entry can only mean mask this", () => {
        const out = maskValue({ accountName: "Example Telecom LLC", status: "ACTIVE" }, 7, { extraFields: ["accountName", "status"] });
        assert.match(out.accountName, /^personal#/);
        assert.match(out.status, /^personal#/);
    });

    it("does not leak into another masker, whatever order they are used in", () => {
        const input = { subscriberAlias: "Bobby" };
        assert.equal(maskValue(input).subscriberAlias, "Bobby");
        assert.match(maskValue(input, 7, options).subscriberAlias, /^personal#/);
        assert.equal(maskValue(input).subscriberAlias, "Bobby");
        assert.equal(maskValue(input, 7, { extraFields: [] }).subscriberAlias, "Bobby");
    });

    it("refuses a name that could never match, rather than leaving the field unmasked", () => {
        for (const extraFields of [[""], [" "], ["---"], ["ok", ""], [42 as unknown as string], "subscriberAlias" as unknown as string[]]) {
            assertFailsClosed(() => masker(7, { extraFields }), JSON.stringify(extraFields));
        }
        assert.doesNotThrow(() => masker(7, { extraFields: [] }));
        assert.doesNotThrow(() => masker(7, {}));
    });

    it("has no effect on the names that are not listed", () => {
        const input = { orderId: "ord-1", note: "see you", email: "person@example.com", phone: "202-555-0123" };
        assert.deepEqual(maskValue(input, 3, options), maskValue(input, 3));
    });
});
