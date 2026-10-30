// Encodings, grouped values, identifiers and percent literals.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertWithheld, maskText, maskValue, masker, occurrences, render } from "./mask-support.ts";

describe("phones, addresses and log fields", () => {
    it("removes extensions and masks international phones", () => {
        for (const input of ["call +12025550123 ext. 345", "call +442079460958 x123"]) {
            const out = maskText(input);
            assert.ok(!out.includes("ext."), out);
            assert.ok(!out.includes("x123"), out);
        }
        assert.doesNotThrow(() => maskValue({ phone: "+6561234567" }));
    });

    it("masks free-text addresses and log fields", () => {
        for (const [input, forbidden] of [
            ["Install at 123 Example Lane", "123 Example Lane"],
            ["username=alex.example", "alex.example"],
            ['name="Casey Sample"', "Casey Sample"],
            ['password="fake secret pass"', "secret pass"],
        ] as const) {
            const out = maskText(input);
            assert.ok(!out.includes(forbidden), out);
        }
        assert.equal(maskText("deviceId=abc-secret-id"), "deviceId=abc-secret-id"); // an id is not personal data
    });

    it("removes the whole address that follows a street, and nothing but the address", () => {
        assert.equal(
            maskText("Install at 654 Example Blvd, Test City, OR 00000, US before Friday"),
            "Install at [removed:address] before Friday",
        );
        assert.equal(maskText("Meet at 1 A St, today"), "Meet at [removed:address]");
    });

    it("gives one network identifier one token across fields and text", () => {
        const m = masker();
        for (const [key, value] of [
            ["clientIp", "::ffff:192.0.2.1"],
            ["clientIp", "2001:DB8::A"],
            ["sourceIp", "203.0.113.9"],
        ] as const) {
            const field = m.value({ [key]: value })[key] as string;
            const sentence = m.text(`peer ${value}`);
            assert.ok(sentence.includes(field), `${sentence}, ${field}`);
        }
    });

    it("leaves internal addresses and device identifiers readable", () => {
        assert.deepEqual(maskValue({ clientIp: "10.1.2.3", macAddress: "AA:BB:CC:DD:EE:FF" }), {
            clientIp: "10.1.2.3",
            macAddress: "AA:BB:CC:DD:EE:FF",
        });
        assert.equal(maskText("peer AA:BB:CC:DD:EE:FF at 192.168.1.5"), "peer AA:BB:CC:DD:EE:FF at 192.168.1.5");
    });

    it("still scans the inside of a safe field's container", () => {
        assert.ok(!render(maskValue({ orderId: ["person@example.com"] })).includes("person@example.com"));
    });

    it("parses encoded arrays inside text", () => {
        const out = maskText('payload=[ "password=secret", "person@example.com" ]');
        assert.ok(!out.includes("secret"), out);
        assert.ok(!out.includes("person@example.com"), out);
    });

    it("consumes unquoted grouped values whole", () => {
        const phone = maskText("phone=202-555-0123 ext. 345 orderId=ord-7");
        assert.ok(!phone.includes("ext."));
        assert.ok(!phone.includes("345"));
        assert.ok(phone.includes("0123"));
        assert.ok(phone.includes("ord-7"));
        const card = maskText("cardNumber=4111 1111 1111 1111 orderId=ord-8");
        assert.ok(!card.includes("4111 1111"));
        assert.ok(!card.includes("1111 1111"));
        assert.ok(card.includes("card ****1111"));
        assert.ok(card.includes("ord-8"));
    });

    it("withholds a string with an unterminated sensitive quote", () => {
        assertWithheld(() => maskText('password="fake secret pass'));
    });

    it("treats source slices and brace placeholders as text, but withholds truncated JSON", () => {
        for (const input of [
            "public class Shipment {\n  void save() {",
            "callback <shipmentId>:manual {example}",
            "### Source\n```groovy\nclass Bolt {\n",
            'if (ok) { payload={"password":"fake-secret"};',
        ]) {
            assert.ok(!maskText(input).includes("fake-secret"));
        }
        assertWithheld(() => maskText('payload={"password":"fake-secret"'));
        assertWithheld(() => maskText('payload={\\"password\\":\\"fake-secret\\"'));
    });
});

describe("tokens counts and identifiers", () => {
    it("keeps exact token counts and nulls typed, but never credentials", () => {
        const value = maskValue({
            tokens: "secret", // a string under this name is a credential; only numbers and null are usage counters
            timeline: [{ tokens: null }],
            input_tokens: null,
            token: "secret",
            tokens_text: "secret",
            password_tokens: 15,
        });
        assert.equal(value.timeline[0].tokens, null);
        assert.equal(value.input_tokens, null);
        assert.equal(value.token, "[removed:credential]");
        assert.equal(value.tokens, "[removed:credential]");
        assert.equal(value.password_tokens, "[removed:credential]");
        assert.equal(maskValue({ tokens: 12 }).tokens, 12);
    });

    it("keeps identifiers across sources and keys while removing credentials", () => {
        const m = masker(9);
        const a = "abcdef0123456789abcdef01";
        const b = "abcdef0123456789abcdef02";
        const result = m.value({ _id: { $oid: a }, OriginId: a, provisionId: b, password: a, access_token: b });
        assert.equal(result._id.$oid, result.OriginId);
        assert.notEqual(result.OriginId, result.provisionId);
        assert.equal(result.password, "[removed:credential]");
        assert.equal(result.access_token, "[removed:credential]");
        assert.equal(result.OriginId, a);
        assert.equal(result.provisionId, b);
        assert.equal(maskValue({ OriginId: a }, 10).OriginId, result.OriginId);
        assert.deepEqual(m.value(result), result, "masking masked output must change nothing");
        assert.ok(m.text(`OriginId=${a}`).includes(result.OriginId));
    });

    it("keeps identifier fields and Mongo predicates but never credential shapes", () => {
        const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.SKU000001.12_unit";
        const result = maskValue({
            OriginId: id,
            "order.products.appIds": { $in: [id] },
            parentAccountId: id,
            parentOrderId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            password: id,
            provisionId: "Bearer fixture-secret-value",
            _id: "person@example.invalid",
        });
        assert.equal(result.OriginId, id);
        assert.equal(result["order.products.appIds"].$in[0], id);
        assert.equal(result.parentAccountId, id);
        assert.equal(result.password, "[removed:credential]");
        assert.equal(result.provisionId, "[removed:credential]");
        assert.ok(!render(result).includes("person@example.invalid"));
        assert.ok(!render(result).includes("fixture-secret-value"));
    });
});

describe("percent-encoded query values", () => {
    const sentences = [
        "GET /?discount=100%25&email=person%40example.com",
        "GET /?discount=100%2525&password=fake%2525secret",
        "GET /?label=percent%25sign&email=person%2540example.com",
        "GET /?email=person%2540example.com&discount=100%25",
        "GET /?email=person%252540example.com&discount=100%252525",
        "GET /?note=cost%3D100%25%3Bperson%2540example.com&discount=100%25",
        "GET /?note=password%253Dfake%2525secret&discount=100%25",
    ];

    it("accepts valid percent literals without rejecting the whole result", () => {
        for (const input of sentences) {
            const masked = maskText(input);
            assert.ok(masked.includes("%"), masked);
            assert.ok(!masked.includes("person"), masked);
            assert.ok(!masked.includes("secret"), masked);
            assert.ok(!masked.includes("example.com"), masked);
            const nested = maskValue({ hits: [{ _source: { message: input } }] });
            assert.equal(nested.hits[0]._source.message, masked);
        }
    });

    it("withholds strings with malformed or over-nested encodings", () => {
        for (const input of [
            "GET /?email=person%XXexample.com",
            "GET /?email=person%",
            "GET /?email=person%2",
            "GET /?email=%FF",
            "GET /?em%XXail=person%40example.com",
            "GET /?email=person%2525252540example.com",
            "GET /?discount=100%25&email=person%XXexample.com",
            "GET /?note%25password%3Dfake-secret=value",
            "GET /?note%2525=value",
        ]) {
            assertWithheld(() => maskText(input), input);
        }
    });

    it("removes ambiguous nested fields with literal percents whole", () => {
        for (const field of ["note", "version", "provisionId"]) {
            for (const value of [
                "cost%3D100%25%3Bpassword%3Dfake-secret",
                "cost%3D100%25%3Bpassword%253Dfake-secret",
                "cost%3D100%25%2Cpassword%253Dfake-secret",
                "%22cost%3D100%25%3Bpassword%3Dfake-secret%22",
                "%7B%22password%22%3A%22fake-secret%22%2C%22cost%22%3A%22100%25%22%7D",
            ]) {
                const input = `GET /?${field}=${value}&discount=100%25`;
                const masked = maskText(input);
                assert.ok(!masked.includes("fake-secret"), masked);
                assert.ok(!masked.includes("fake%"), masked);
                assert.ok(masked.includes("discount=100%"), masked);
                assert.equal(occurrences(masked, "[removed:sensitive]"), 1, masked);
                const nested = maskValue({ hits: [{ _source: { message: input } }] });
                assert.equal(nested.hits[0]._source.message, masked);
            }
        }
    });

    it("stops safe fields with literal percents from bypassing privacy masking", () => {
        for (const field of ["version", "status", "accountId"]) {
            for (const value of ["person%40example.com%25", "%2B12025550123%25", "100%25"]) {
                const masked = maskText(`GET /?${field}=${value}&discount=100%25`);
                assert.ok(!masked.includes("person"), masked);
                assert.ok(!masked.includes("example.com"), masked);
                assert.ok(!masked.includes("12025550123"), masked);
                assert.ok(masked.includes("discount=100%"), masked);
                assert.equal(occurrences(masked, "[removed:sensitive]"), 1, masked);
            }
        }
    });
});
