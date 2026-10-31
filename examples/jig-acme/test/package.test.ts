// The package manifest is how Pi finds the plugin and its skills: one that points at nothing simply loads nothing. And the skill is
// checked the way jig-core checks its own: Pi skips a skill whose front matter is not valid YAML, so the agent silently loses it.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    name: string;
    private?: boolean;
    keywords?: string[];
    peerDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
    pi: { extensions: string[]; skills: string[] };
};

describe("the package manifest", () => {
    test("names the entry point and the skills folder, and both exist", () => {
        assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
        assert.deepEqual(manifest.pi.skills, ["./skills"]);
        for (const entry of [...manifest.pi.extensions, ...manifest.pi.skills]) {
            assert.ok(existsSync(path.join(root, entry)), entry);
        }
    });

    test("is a Pi package that is private and needs only Pi: Jig is reached at run time, not as a dependency", () => {
        assert.ok(manifest.keywords?.includes("pi-package"));
        assert.equal(manifest.private, true);
        assert.equal(manifest.dependencies, undefined);
        assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), [
            "@earendil-works/pi-ai",
            "@earendil-works/pi-coding-agent",
            "@earendil-works/pi-tui",
            "typebox",
        ]);
    });

    test("is not part of what `pi install` takes from Jig's own package", () => {
        const jigs = JSON.parse(readFileSync(path.resolve(root, "../../package.json"), "utf8")) as {
            pi: { extensions: string[]; skills: string[] };
        };
        for (const entry of [...jigs.pi.extensions, ...jigs.pi.skills])
            assert.equal(entry.includes("examples"), false, entry);
    });
});

describe("the skills", () => {
    const skills = path.join(root, "skills");
    const names = readdirSync(skills);

    test("the company has the one overlay it needs", () => {
        assert.deepEqual(names, ["acme-jira"]);
    });

    test("each has front matter Pi can read, with the folder's name and a description that says when to use it", () => {
        for (const name of names) {
            const file = path.join(skills, name, "SKILL.md");
            const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, "utf8"));
            assert.ok(match, `${name}: no front matter`);
            const front = parse(match[1] ?? "") as Record<string, unknown>;
            assert.equal(front.name, name, "the name is the folder's");
            assert.equal(typeof front.description, "string");
            assert.match(String(front.description), /Use whenever|Use when/, "the description says when to use it");
        }
    });

    test("the Jira overlay agrees with the ticket pattern, the branch rule and the title rule", async () => {
        const text = readFileSync(path.join(skills, "acme-jira", "SKILL.md"), "utf8");
        const { memoryDefaults } = await import("../src/defaults/memory.ts");
        const { gitDefaults } = await import("../src/defaults/git.ts");
        const key = /\*\*([A-Z]+)\*\* is the product project/.exec(text)?.[1];
        assert.equal(key, "ACME");
        assert.ok(new RegExp(`^${memoryDefaults.ticketPattern}$`).test("ACME-123"));
        assert.ok(new RegExp(gitDefaults.branchName).test("feature/ACME-123"));
        assert.ok(new RegExp(gitDefaults.prTitle).test("ACME-123: add the order filter"));
        assert.ok(text.includes("`feature/ACME-123`") && text.includes("`ACME-123: add the order filter`"));
    });

    test("is short enough to read before acting", () => {
        for (const name of names) {
            assert.ok(readFileSync(path.join(skills, name, "SKILL.md"), "utf8").split("\n").length <= 70, name);
        }
    });
});
