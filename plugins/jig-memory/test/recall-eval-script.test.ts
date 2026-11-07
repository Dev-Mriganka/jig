// The generic recall script runs on any folder and prints aggregates only. Invented notes cover it without real data: one
// note names another ticket, one does not, and the score must find the named one without printing a key.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tempFolder } from "./support.ts";
import { ticketPaths } from "../src/store.ts";

const SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "recall-eval.mjs");

function writeNote(folder: string, key: string, text: string): void {
    mkdirSync(ticketPaths(folder, key).dir, { recursive: true });
    writeFileSync(ticketPaths(folder, key).notes, text);
}

test("hand labels replace derived links, and top 3 is not capped by the display budget", (t) => {
    const folder = tempFolder(t);
    for (const key of ["PROJ-1", "PROJ-2", "PROJ-3"]) {
        writeNote(folder, key, `# ${key}\n\n## Now\nStatus: OrderService NullPointerException\n\n## Decisions\n`);
    }
    for (let n = 0; n < 10; n++) {
        writeNote(folder, `FILL-${n}`, `# FILL-${n}\n\n## Now\nStatus: filler${n}\n\n## Decisions\n`);
    }
    const labels = path.join(folder, "labels.json");
    writeFileSync(
        labels,
        JSON.stringify({
            pairs: [
                ["PROJ-1", "PROJ-2"],
                ["PROJ-2", "PROJ-3"],
            ],
        }),
    );
    const stdout = execFileSync(
        process.execPath,
        [SCRIPT, "--folder", folder, "--labels", labels, "--top", "3", "--max-notes", "3"],
        { encoding: "utf8" },
    );
    const result = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(result.labelled, true);
    assert.equal(result.pairs, 2);
    assert.equal(result.cases, 3);
    assert.equal(result.top, 3);
    assert.equal(result.maxNotes, 3, "the top-3 retrieval is not capped by the display default");
    assert.equal(result.hits, 4, "all four label directions are retrieved");
    assert.equal(result.pairsFoundAny, 2, "both labelled pairs are found");
    assert.equal(stdout.includes("PROJ-1"), false);
});

test("the script finds an invented linked ticket from notes, and prints no key", (t) => {
    const folder = tempFolder(t);
    writeNote(
        folder,
        "PROJ-1",
        "# PROJ-1\n\n## Now\nStatus: OrderService throws NullPointerException\n\n## Decisions\nSee PROJ-2 for the mapper fix.\n",
    );
    writeNote(
        folder,
        "PROJ-2",
        "# PROJ-2\n\n## Now\nStatus: OrderService returns a null customer\n\n## Decisions\nCheck for null.\n",
    );
    writeNote(folder, "PROJ-3", "# PROJ-3\n\n## Now\nStatus: a footer is the wrong colour\n\n## Decisions\n");
    const stdout = execFileSync(process.execPath, [SCRIPT, "--folder", folder, "--mode", "notes"], {
        encoding: "utf8",
    });
    const result = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(result.mode, "notes");
    assert.equal(result.tickets, 3);
    assert.equal(result.cases, 1);
    assert.equal(result.hits, 1);
    assert.equal(result.recallAt3, 1);
    assert.equal(stdout.includes("PROJ-1"), false);
    assert.equal(stdout.includes("NullPointerException"), false);
    const cards = JSON.parse(
        execFileSync(process.execPath, [SCRIPT, "--folder", folder, "--mode", "cards"], { encoding: "utf8" }),
    ) as Record<string, unknown>;
    assert.equal(cards.hits, 0);
});

test("the script prints only its error object on a bad folder or bad labels", (t) => {
    const folder = tempFolder(t);
    const badFolder = spawnSync(process.execPath, [SCRIPT, "--folder", path.join(folder, "missing")], {
        encoding: "utf8",
    });
    assert.equal(badFolder.status, 1);
    assert.equal(badFolder.stdout, '{"error":true}\n');
    assert.equal(badFolder.stderr, "");

    const labels = path.join(folder, "bad-labels.json");
    writeFileSync(labels, "{not json");
    const badLabels = spawnSync(process.execPath, [SCRIPT, "--folder", folder, "--labels", labels], {
        encoding: "utf8",
    });
    assert.equal(badLabels.status, 1);
    assert.equal(badLabels.stdout, '{"error":true}\n');
    assert.equal(badLabels.stderr, "");
    assert.equal(badLabels.stdout.includes(folder), false);
});
