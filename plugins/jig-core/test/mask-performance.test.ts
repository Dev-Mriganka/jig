// Masking runs on every production result, so it must stay fast on realistic 1 MiB logs and must not blow up
// (catastrophic backtracking) on hostile text shapes. Budgets are about 10x the time measured on an idle machine:
// they catch a stall (minutes), not a small slowdown, and stay green under parallel load.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MaskError } from "../src/mask/index.ts";
import { MAX_BYTES as LIMIT_BYTES } from "../src/mask/limits.ts";
import { maskText, maskValue, occurrences } from "./mask-support.ts";

const MAX_BYTES = 1_048_576;

/** A deterministic, varied log of about `bytes` bytes: access lines, JSON payloads, stack traces and plain notes. */
function realisticLog(bytes: number): { text: string; secrets: string[] } {
    const lines: string[] = [];
    const secrets: string[] = [];
    let size = 0;
    for (let i = 0; size < bytes; i++) {
        const email = `customer${i}@example.com`;
        const phone = `+1202555${String(i % 10_000).padStart(4, "0")}`;
        const ip = `203.${i % 250}.${(i * 7) % 250}.${(i * 13) % 250}`; // public: internal addresses are not masked
        let line: string;
        switch (i % 5) {
            case 0:
                line = `2026-10-13T10:11:${String(i % 60).padStart(2, "0")}.345Z INFO [order-service] orderId=ord-${i} accountId=acct-${i % 97} GET /v2/orders?accountId=acct-${i % 97}&status=ACTIVE took ${i % 900}ms from ${ip} user=agent${i}`;
                secrets.push(ip);
                break;
            case 1:
                line = `2026-10-13T10:11:12.001Z WARN [notify] payload={"orderId":"ord-${i}","contactEmail":"${email}","contactPhone":"${phone}","version":"2.${i % 40}.1","items":[{"sku":"SKU-${i % 500}","qty":${i % 7}}]}`;
                secrets.push(email, phone);
                break;
            case 2:
                line = `2026-10-13T10:11:12.002Z ERROR [callback] Callback requested on ${phone}; note: install at 12${i % 90} Example Lane, Sample City, CA 94000, US before Friday`;
                secrets.push(phone, "Example Lane");
                break;
            case 3:
                line = `\tat com.example.orders.Handler.process(Handler.java:${100 + (i % 400)})\n\tat com.example.orders.Dispatcher.run(Dispatcher.java:${50 + (i % 90)})`;
                break;
            default:
                line = `2026-10-13T10:11:12.003Z DEBUG [cdr] call to ${phone} lasted ${i % 600} seconds callId=call-${i} peer=2001:db8::${(i % 4096).toString(16)} cardNumber=4111 1111 1111 1111`;
                secrets.push(phone, "4111 1111 1111 1111");
        }
        lines.push(line);
        size += line.length + 1;
    }
    return { text: lines.join("\n").slice(0, bytes), secrets };
}

/** CPU time of this process, not wall time: the suite runs files in parallel, and contention is not a regression. */
function timed<T>(work: () => T): { result: T; ms: number } {
    const start = process.cpuUsage();
    const result = work();
    const used = process.cpuUsage(start);
    return { result, ms: (used.user + used.system) / 1000 };
}

describe("performance", () => {
    it("masks one 4 MB log value (a whole API response in one line) within the limits, in under 8 seconds", () => {
        const { text } = realisticLog(4_000_000);
        const { ms } = timed(() => maskValue({ hits: [{ message: text }] }));
        console.log(`  4 MB single value masked in ${ms.toFixed(0)} ms`);
        assert.ok(ms < 8_000, `took ${ms.toFixed(0)} ms`);
    });

    it("still refuses input above the size limit instead of passing it unmasked", () => {
        assert.throws(() => maskText("x".repeat(LIMIT_BYTES + 1)), (error: Error) => error.name === "MaskError" && /input size/.test(error.message));
    });

    it("masks about 1 MiB of realistic log text in under 8 seconds", () => {
        const { text, secrets } = realisticLog(1_000_000);
        assert.ok(text.length > 990_000 && text.length <= MAX_BYTES);
        // Best of two runs: the suite runs files in parallel, so one run can be slowed by its neighbours.
        const runs = [timed(() => maskText(text)), timed(() => maskText(text))];
        const ms = Math.min(...runs.map((run) => run.ms));
        const masked = (runs[0] as { result: string }).result;
        console.log(`  1 MB realistic log masked in ${ms.toFixed(0)} ms`);
        assert.ok(ms < 8_000, `took ${ms.toFixed(0)} ms`);
        for (const secret of secrets.slice(0, 2_000)) assert.ok(!masked.includes(secret), `leaked ${secret}`);
        assert.ok(occurrences(masked, "phone#") > 1_000);
        assert.ok(masked.includes("ord-"), "diagnostic ids must survive");
    });

    it("masks a search-response-shaped value with 5 000 hits in under 8 seconds", () => {
        const hits = Array.from({ length: 5_000 }, (_, i) => ({
            _id: `abcdef0123456789abcdef${String(i).padStart(2, "0")}`,
            _source: { "@timestamp": "2026-10-13T10:11:12Z", message: `order ord-${i} for user${i}@example.com from 10.0.${i % 250}.1`, level: "INFO" },
        }));
        const { ms } = timed(() => maskValue({ hits: { hits } }));
        console.log(`  5k-hit value masked in ${ms.toFixed(0)} ms`);
        assert.ok(ms < 8_000, `took ${ms.toFixed(0)} ms`);
    });

    // Each shape would take minutes with a backtracking-prone pattern; here each must finish quickly or fail closed.
    const hostile: Array<[string, string]> = [
        ["email local-part characters", "a%".repeat(500_000)],
        ["dots", ".".repeat(1_000_000)],
        ["dotted digits", "1.".repeat(500_000)],
        ["JWT headers", "eyJ-".repeat(250_000)],
        ["digit groups", "1 ".repeat(500_000)],
        ["digit dashes", "1-".repeat(500_000)],
        ["street starts", "1 a St, ".repeat(125_000)],
        ["at signs", "x@".repeat(500_000)],
        ["domain dots", "a@a.a.a.a.".repeat(100_000)],
        ["log fields", "k=v ".repeat(250_000)],
        ["whitespace", " ".repeat(1_000_000)],
        ["colons", ":".repeat(1_000_000)],
        ["hex and colons", "ab:".repeat(333_000)],
        ["open braces", "{ ".repeat(500_000)],
        ["phones", "202-555-0123 ".repeat(80_000)],
        ["whitespace after a phone key", `phone=${" ".repeat(900_000)}`],
        ["plus signs", "+1 ".repeat(330_000)],
        ["bearer words", "Bearer ".repeat(140_000)],
        ["token keys", "token=".repeat(170_000)],
        ["authorization keys", "Authorization: ".repeat(65_000)],
        ["angle brackets", "<a ".repeat(330_000)],
        ["query separators", "?a=b&".repeat(200_000)],
        ["unfinished encodings", "?a=%41".repeat(170_000)],
    ];

    for (const [name, text] of hostile) {
        it(`does not stall on ${name}`, () => {
            const { ms } = timed(() => {
                try {
                    maskText(text.slice(0, MAX_BYTES));
                } catch (error) {
                    assert.ok(error instanceof MaskError, "failing closed is allowed; anything else is a bug");
                }
            });
            // A runaway pattern takes minutes; these finish in about a second alone but can be slowed many times on a
            // heavily loaded host, so the ceiling catches a stall without failing on a busy machine.
            assert.ok(ms < 30_000, `took ${ms.toFixed(0)} ms`);
        });
    }
});
