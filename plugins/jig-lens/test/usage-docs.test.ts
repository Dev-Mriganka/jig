// The usage page says what the code does, and the paths it reads are Pi's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentDir, sessionsDir } from "../src/paths.ts";
import { HELP, PERIODS } from "../src/usage-dashboard.ts";
import { MAX_MODEL_NAMES, MODEL_NAMES_EVENT } from "../src/usage-names.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..");
const page = readFileSync(path.join(PLUGIN, "docs/usage.md"), "utf8");
const readme = readFileSync(path.join(PLUGIN, "README.md"), "utf8");

test("the page names the periods and keys the view has, in the order the view has them", () => {
    for (const period of PERIODS) assert.ok(page.includes(period.label), period.label);
    assert.ok(
        page.includes("[Today]  This week  Last week  30 days  All time"),
        "the periods row, as the view shows it",
    );
    assert.ok(page.includes(HELP), "the keys line, as the view shows it");
    for (const key of ["`←` `→`", "`v` or `Tab`", "`m`", "`↑` `↓`", "`q` or `Esc`"]) assert.ok(page.includes(key), key);
});

test("the page documents the event and its limits as the code has them", () => {
    assert.ok(page.includes(`"${MODEL_NAMES_EVENT}"`));
    assert.ok(page.includes(String(MAX_MODEL_NAMES)));
    assert.match(page, /up to 80 characters/);
    assert.match(page, /up to 60 characters/);
});

test("the credit line is there, word for word, and the README says what /lens usage is", () => {
    assert.ok(
        page.includes(
            "The dashboard interaction was inspired by Thomas Mustier's usage extension\n(https://github.com/tmustier/pi-extensions); its implementation is original.",
        ),
    );
    assert.match(
        readme,
        /`\/lens usage` is a quick view of cost and tokens from Pi's own session files;\nTokenTelemetry goes further/,
    );
    assert.match(readme, /\| `\/lens usage` \|/);
    assert.match(readme, /\(docs\/usage\.md\)/);
});

test("session files are looked for where Pi keeps them: its agent folder, which PI_CODING_AGENT_DIR moves", () => {
    assert.equal(agentDir({}), path.join(homedir(), ".pi", "agent"));
    assert.equal(sessionsDir({}), path.join(homedir(), ".pi", "agent", "sessions"));
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/data/pi" }), "/data/pi");
    assert.equal(sessionsDir({ PI_CODING_AGENT_DIR: "/data/pi" }), "/data/pi/sessions");
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/work/pi" }), path.join(homedir(), "work/pi"));
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~" }), homedir());
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "" }), path.join(homedir(), ".pi", "agent"));
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "relative/dir" }), path.resolve("relative/dir"));
});
