// The shared masking corpus: synthetic canaries across categories (test/mask-corpus/*.json). Every case states what
// must not survive, what must stay, and which token prefixes must appear. Expected outputs are structural because
// tokens depend on the key.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { masker, render } from "./mask-support.ts";

interface Case {
    id: string;
    input: unknown;
    must_not_contain: string[];
    must_keep: string[];
    expect_tags: string[];
}

interface Fixture {
    category: string;
    cases: Case[];
}

const dir = new URL("./mask-corpus/", import.meta.url);
const fixtures: Fixture[] = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "field-names.json")
    .sort()
    .map((name) => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as Fixture);

/** Tokens print as `tag#`, except cards whose display contract is `card ****last4`. */
const marker = (tag: string): string => (tag === "card" ? "card ****" : `${tag}#`);

describe("masking corpus", () => {
    it("has unique case ids across all categories", () => {
        const ids = fixtures.flatMap((fixture) => fixture.cases.map((c) => c.id));
        assert.equal(fixtures.length, 15);
        assert.equal(ids.length, 85);
        assert.equal(new Set(ids).size, ids.length, "duplicate fixture id");
    });

    for (const fixture of fixtures) {
        for (const c of fixture.cases) {
            it(`${fixture.category} / ${c.id}`, () => {
                const m = masker(42);
                const masked = m.value(structuredClone(c.input));
                const text = render(masked);

                if (typeof c.input === "string") assert.equal(masked, m.text(c.input), "text() and value() disagree");
                for (const needle of c.must_not_contain) assert.ok(!text.includes(needle), `leaked ${JSON.stringify(needle)} in ${text}`);
                for (const needle of c.must_keep) assert.ok(text.includes(needle), `lost ${JSON.stringify(needle)} in ${text}`);
                for (const tag of c.expect_tags) assert.ok(text.includes(marker(tag)), `missing ${marker(tag)} in ${text}`);

                assert.equal(render(m.value(structuredClone(c.input))), text, "nondeterministic output");
            });
        }
    }
});
