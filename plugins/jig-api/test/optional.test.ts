// Optional variables: what hangs on one that nobody gave a value is left out of the request, and nothing else is.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SavedRequest } from "../src/model.ts";
import { pruned } from "../src/optional.ts";

function request(parts: Partial<SavedRequest>): SavedRequest {
    return {
        collection: "c", folder: [], name: "r", origin: "r", method: "GET", url: "{{serverUrl}}/orders", headers: [], auth: { kind: "none" },
        variables: [], secrets: [], signsIn: [], defaults: new Map(), scripts: { prerequest: false }, notes: [], ...parts,
    };
}
const unset = (...names: string[]): ReadonlySet<string> => new Set(names);

describe("the query string", () => {
    const url = "{{serverUrl}}/orders?status={{status}}&limit={{limit}}&fixed=1&both={{a}}-{{b}}";

    test("a pair whose value is an unset variable is dropped, and the others stay in order", () => {
        assert.equal(pruned(request({ url }), unset("status")).url, "{{serverUrl}}/orders?limit={{limit}}&fixed=1&both={{a}}-{{b}}");
        assert.equal(pruned(request({ url }), unset("limit")).url, "{{serverUrl}}/orders?status={{status}}&fixed=1&both={{a}}-{{b}}");
    });

    test("the question mark goes with the last pair", () => {
        assert.equal(pruned(request({ url: "{{serverUrl}}/orders?status={{ status }}" }), unset("status")).url, "{{serverUrl}}/orders");
    });

    test("a pair that holds more than the variable is not touched, and nothing is dropped without an unset variable", () => {
        assert.equal(pruned(request({ url }), unset("a")).url, url);
        assert.equal(pruned(request({ url }), unset()).url, url);
        assert.equal(pruned(request({ url: "{{serverUrl}}/orders" }), unset("status")).url, "{{serverUrl}}/orders");
    });
});

describe("headers", () => {
    const headers = [["X-Request-Id", "{{requestId}}"], ["X-Fixed", "1"], ["X-Both", "a{{requestId}}"]] as const;

    test("a header whose whole value is an unset variable is dropped", () => {
        assert.deepEqual(pruned(request({ headers }), unset("requestId")).headers, [["X-Fixed", "1"], ["X-Both", "a{{requestId}}"]]);
        assert.deepEqual(pruned(request({ headers }), unset()).headers, headers);
    });
});

describe("a JSON body", () => {
    const text = ['{', '  "customerId": "{{customerId}}",', '  "quantity": {{quantity}},', '  "note": "{{note}}",', '  "address": {', '    "city": "{{city}}"', '  }', '}'].join("\n");

    test("a property on a line of its own is dropped, and the comma that is left over goes with it", () => {
        const body = pruned(request({ method: "POST", body: { kind: "json", text } }), unset("note")).body;
        assert.equal(body?.kind === "json" ? body.text : "", ['{', '  "customerId": "{{customerId}}",', '  "quantity": {{quantity}},', '  "address": {', '    "city": "{{city}}"', '  }', '}'].join("\n"));
    });

    test("the last property can be the one dropped, and the result is still JSON once the variables are filled", () => {
        const body = pruned(request({ method: "POST", body: { kind: "json", text } }), unset("city", "quantity")).body;
        const left = body?.kind === "json" ? body.text : "";
        assert.equal(left, ['{', '  "customerId": "{{customerId}}",', '  "note": "{{note}}"', '}'].join("\n"));
        const filled = left.replace("{{customerId}}", "c-1").replace("{{note}}", "hi");
        assert.deepEqual(JSON.parse(filled), { customerId: "c-1", note: "hi" });
    });

    test("an object whose properties were all left out is left out, and one with a property left stays", () => {
        const nested = ['{', '  "a": "{{a}}",', '  "outer": {', '    "inner": {', '      "x": "{{x}}"', '    },', '    "y": "{{y}}"', '  }', '}'].join("\n");
        const text = (set: string[]): string => {
            const body = pruned(request({ method: "POST", body: { kind: "json", text: nested } }), unset(...set)).body;
            return body?.kind === "json" ? body.text : "";
        };
        assert.equal(text(["x", "y"]), ['{', '  "a": "{{a}}"', '}'].join("\n"));
        assert.equal(text(["x"]), ['{', '  "a": "{{a}}",', '  "outer": {', '    "y": "{{y}}"', '  }', '}'].join("\n"));
        assert.deepEqual(JSON.parse(text(["x"]).replace("{{a}}", "1").replace("{{y}}", "2")), { a: "1", outer: { y: "2" } });
    });

    test("a body that is not JSON is left as it is", () => {
        const raw = { kind: "raw", text: '"note": "{{note}}"' } as const;
        assert.deepEqual(pruned(request({ method: "POST", body: raw }), unset("note")).body, raw);
    });
});
