// Pi skips a skill whose front matter is not valid YAML and reports it at start-up, so the agent silently loses it.
// Every skill in the repository is checked here, so a stray colon fails the build instead.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const PLUGINS = path.resolve(import.meta.dirname, "../..");

function skillFiles(): string[] {
    const files: string[] = [];
    for (const plugin of readdirSync(PLUGINS)) {
        const skills = path.join(PLUGINS, plugin, "skills");
        let names: string[];
        try {
            names = readdirSync(skills);
        } catch {
            continue;
        }
        for (const name of names) files.push(path.join(skills, name, "SKILL.md"));
    }
    return files;
}

test("every skill has front matter Pi can read, with a name and a description", () => {
    const files = skillFiles();
    assert.ok(files.length > 0, "the repository has skills");
    for (const file of files) {
        const where = path.relative(PLUGINS, file);
        const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, "utf8"));
        assert.ok(match, `${where}: no front matter`);
        const front = parse(match[1] ?? "") as Record<string, unknown>;
        assert.equal(typeof front.name, "string", `${where}: name`);
        assert.equal(typeof front.description, "string", `${where}: description`);
        assert.equal(front.name, path.basename(path.dirname(file)), `${where}: the name is the folder's`);
    }
});
