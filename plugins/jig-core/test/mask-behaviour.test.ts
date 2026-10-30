// The contract of a masker: determinism, key separation, purity, scalar handling, and no surviving originals.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMasker } from "../src/mask/index.ts";
import { deepFreeze, keyOf, maskText, maskValue, masker, occurrences, render } from "./mask-support.ts";

describe("determinism and keys", () => {
    it("gives the same token for the same value, category and key, across calls and maskers", () => {
        const a = createMasker(keyOf(1));
        const b = createMasker(keyOf(1));
        const input = { email: "person@example.com", note: "mail person@example.com from 192.0.2.1" };
        assert.deepEqual(a.value(input), a.value(input));
        assert.deepEqual(a.value(input), b.value(input));
        assert.equal(a.text("call 202-555-0123"), b.text("call 202-555-0123"));
    });

    it("gives different tokens under a different key", () => {
        const input = { email: "person@example.com", phone: "202-555-0123", ip: "192.0.2.1", name: "Casey Sample" };
        assert.notDeepEqual(createMasker(keyOf(1)).value(input), createMasker(keyOf(2)).value(input));
    });

    it("includes the category in the token, so one value in two roles gives two tokens", () => {
        const { name, user } = maskValue({ name: "alex", user: "alex", username: "alex" });
        assert.notEqual(name.slice(5), user.slice(5));
    });

    it("correlates one value across fields, text and spellings", () => {
        const m = masker();
        const email = m.value({ email: " Person@Example.COM " }).email;
        assert.ok(m.text("note: person@example.com.").includes(email));
        const v6 = m.value({ ipAddress: "2001:DB8:0:0:0:0:0:A" }).ipAddress;
        assert.ok(m.text("peer 2001:db8::a refused").includes(v6));
        const phone = m.value({ phone: "(202) 555-0123" }).phone;
        assert.ok(m.text("call +1 202 555 0123 now").includes(phone));
    });
});

describe("purity", () => {
    it("never mutates its input, even when frozen", () => {
        const input = deepFreeze({
            email: "person@example.com",
            tokens: [1, 2],
            contacts: [{ name: "Casey Sample", phone: "202-555-0123" }],
            note: "payload={\"password\":\"x\"} GET /?tn=%2B12025550123",
        });
        const before = structuredClone(input);
        const out = maskValue(input);
        assert.deepEqual(input, before);
        assert.notEqual(out, input);
        assert.notEqual(out.contacts, input.contacts);
        assert.notEqual(out.contacts[0], input.contacts[0]);
    });

    it("returns plain, writable copies", () => {
        const out = maskValue(deepFreeze({ list: [{ a: 1 }] }));
        assert.ok(!Object.isFrozen(out));
        assert.ok(!Object.isFrozen(out.list));
        out.list.push({ a: 2 });
    });

    it("keeps hostile keys as data", () => {
        const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"x","email":"person@example.com"}');
        const out = maskValue(input);
        assert.deepEqual(Object.keys(out), ["__proto__", "constructor", "email"]);
        assert.equal(Object.getPrototypeOf(out), Object.prototype);
        assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    });
});

describe("scalars", () => {
    it("leaves numbers, booleans and null untouched under neutral keys", () => {
        const input = {
            count: 3, ratio: 0.5, big: 1e21, negative: -7, ok: true, off: false, nothing: null, list: [1, true, null],
            durationSeconds: 91,
        };
        assert.deepEqual(maskValue(input), input);
        for (const value of [0, 1.5, true, false, null]) assert.equal(maskValue(value), value);
        assert.equal(maskValue(undefined), undefined);
    });

    it("masks numbers and booleans under a sensitive field name", () => {
        const out = maskValue({ phone: 2025550123, pin: 1234, ssn: 123456789, dob: 19800101, flag: true, password: false, secret: null });
        assert.ok(String(out.phone).startsWith("phone#"));
        for (const key of ["pin", "ssn", "dob", "password", "secret"]) assert.ok(String(out[key]).startsWith("[removed:"), key);
        assert.equal(out.flag, true);
    });

    it("keeps big integers inside embedded JSON exactly as written", () => {
        const out = maskText('INFO payload={"traceNanos":1760345600123456789,"price":1.50,"exp":1e3,"email":"a@b.com"}');
        assert.ok(out.includes('"traceNanos":1760345600123456789'), out);
        assert.ok(out.includes('"price":1.50'), out);
        assert.ok(out.includes('"exp":1e3'), out);
        assert.ok(!out.includes("a@b.com"));
    });

    it("removes a value that is not a phone number from a phone field instead of failing the whole result", () => {
        const out = maskValue({ phone: "N/A", msisdn: "", phoneType: "mobile", tn: "x".repeat(5000) });
        assert.equal(out.phoneType, "mobile"); // a description of the field, not a number
        for (const key of ["phone", "msisdn", "tn"]) assert.equal(out[key], "[removed:phone]");
        assert.equal(maskText("phone=unknown orderId=ord-1"), "phone=[removed:phone] orderId=ord-1");
    });
});

describe("hardening", () => {
    it("finds a card after a digit group that fails the Luhn check", () => {
        const out = maskText("qty 5 4111 1111 1111 1111 ok");
        assert.ok(out.includes("card ****1111"), out);
        assert.ok(!out.includes("4111"), out);
    });

    it("masks a phone number and an IPv6 address at the end of a sentence", () => {
        const phone = maskText("Call +442079460958. Thanks.");
        assert.ok(!phone.includes("442079460958"), phone);
        const ip = maskText("from 2001:db8::1. Then 2001:db8::2: refused");
        assert.ok(!ip.includes("2001"), ip);
        assert.equal(occurrences(ip, "ip#"), 2);
    });

    it("masks public IPv4 addresses printed with leading zeros, and only valid octets", () => {
        const out = maskText("from 008.008.008.008 to 10.0.0.256 via 010.000.000.001");
        assert.ok(!out.includes("008.008.008.008"), out);
        assert.ok(out.includes("10.0.0.256"), out);
        assert.ok(out.includes("010.000.000.001"), "leading zeros read as decimal: 10.0.0.1 is internal");
    });

    it("never masks a token twice, whatever digits the token holds", () => {
        const m = masker();
        for (let i = 0; i < 300; i++) {
            const number = `+1202555${String(1000 + i).padStart(4, "0")}`;
            for (const text of [`GET /port?tn=${encodeURIComponent(number)}&orderId=o`, `callBack=${number} x`, `phone=${number}`, `see ${number}.`]) {
                const out = m.text(text);
                assert.ok(!out.includes("phone#phone#"), out);
                assert.equal(occurrences(out, "phone#"), 1, out);
            }
        }
    });

    it("removes the credential after an authorization scheme word", () => {
        const out = maskText("authorization=Bearer abcdefghijklmnopqrstuvwxyz next=1");
        assert.equal(out, "authorization=[removed:credential] next=1");
    });

    it("finds key=value pairs inside quoted values", () => {
        const out = maskText('WARN note="saw password=fake-passphrase-42 twice" msg=\'token=abc123 x\'');
        assert.ok(!out.includes("fake-passphrase-42"), out);
        assert.ok(!out.includes("abc123"), out);
        assert.ok(out.includes("twice"), out);
    });

    it("checks safe fields for credential shapes in log fields too", () => {
        const out = maskText("status=tok_FAKE_TEST_ONLY_001abcdef version=1.2.3.4");
        assert.ok(!out.includes("tok_FAKE"), out);
        assert.ok(out.includes("version=1.2.3.4"), out);
    });
});

describe("no original sensitive substring survives", () => {
    // `shown` is how the secret appears in a log (some are only recognised in context); `probe` must vanish.
    const secrets: Array<{ shown: string; probe: string }> = [
        ...[
            "alex.example@example.com", "casey_sample+tag@sub.example.co.uk", "+12025550123", "+442079460958", "(202) 555-0147",
            "4111 1111 1111 1111", "5555-5555-5555-4444", "900-12-3456", "192.0.2.77", "2001:db8:85a3::8a2e:370:7334",
            "123 Example Lane", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIn0.c2ln", "tok_FAKE_TEST_ONLY_001abcdef",
        ].map((value) => ({ shown: value, probe: value })),
        { shown: "gps = 40.712776, -74.005974", probe: "40.712776" },
        { shown: "password=fake-passphrase-42", probe: "fake-passphrase-42" },
        { shown: "DOB 01/02/1980", probe: "01/02/1980" },
    ];
    const formats: Array<[string, (secret: string) => unknown]> = [
        ["json value under a neutral key", (s) => ({ note: `see ${s} please` })],
        ["json array", (s) => [`x ${s}`, [`y ${s}`]]],
        ["plain text", (s) => `INFO ${s} end`],
        ["embedded json", (s) => `INFO payload=${JSON.stringify({ message: `a ${s} b` })}`],
        ["escaped json", (s) => `INFO payload=${JSON.stringify(JSON.stringify({ message: `a ${s} b` })).slice(1, -1)}`],
        ["quoted log field", (s) => `WARN note="saw ${s} twice"`],
        ["url query", (s) => `GET /x?q=${encodeURIComponent(s)}&orderId=o-1`],
    ];

    for (const { shown, probe } of secrets) {
        it(shown, () => {
            const m = masker(5);
            for (const [name, build] of formats) {
                const out = render(m.value(build(shown)));
                assert.ok(!out.includes(probe) && !out.includes(probe.replaceAll('"', '\\"')), `${name}: ${out}`);
            }
        });
    }
});
