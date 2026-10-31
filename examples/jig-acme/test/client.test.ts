// The copy of jig-core's client lookup must stay the same as Jig's, or this package and jig-core would stop finding each other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { jig, publishJig, withdrawJig, withJig } from "../src/jig/client.ts";
import type { JigApi } from "../src/jig/types.ts";

const root = path.resolve(import.meta.dirname, "..");
const theirs = path.resolve(root, "../../plugins/jig-core/src/client.ts");

/** The code of a client.ts: from its first type import on, with the path of that import made the same. The header differs. */
function codeOf(file: string): string {
    const text = readFileSync(file, "utf8");
    const from = text.indexOf("import type");
    assert.notEqual(from, -1, `${file} has no import type line`);
    return text.slice(from).replace(/from "\.\/(?:types|contract)\.ts"/, 'from "./contract.ts"');
}

describe("the client handle", () => {
    test("is the same as jig-core's client.ts, apart from its header and the import of the types", () => {
        assert.equal(
            codeOf(path.join(root, "src/jig/client.ts")),
            codeOf(theirs),
            "src/jig/client.ts differs from jig-core's: copy plugins/jig-core/src/client.ts again, keeping this package's " +
                'header and the import of "./types.ts"',
        );
    });

    test("jig() throws while jig-core is not loaded, and withJig waits for it", () => {
        const api = { version: 1 } as unknown as JigApi;
        withdrawJig(api);
        const seen: JigApi[] = [];
        assert.throws(() => jig(), /jig-core is not loaded/);
        withJig((loaded) => seen.push(loaded));
        assert.equal(seen.length, 0, "the callback waits");
        assert.deepEqual(publishJig(api), []);
        assert.deepEqual(seen, [api], "and runs when jig-core publishes its API");
        assert.equal(jig(), api);
        withJig((loaded) => seen.push(loaded));
        assert.equal(seen.length, 2, "with jig-core loaded it runs at once");
        withdrawJig(api);
        assert.throws(() => jig(), /jig-core is not loaded/);
    });

    test("finds the API that jig-core publishes: one handle, whichever copy of the file asks", async () => {
        const { jig: theirJig } = await import("../../../plugins/jig-core/src/client.ts");
        const api = { version: 1 } as unknown as JigApi;
        publishJig(api);
        assert.equal(theirJig(), api, "jig-core's lookup sees what this copy published");
        withdrawJig(api);
    });
});
