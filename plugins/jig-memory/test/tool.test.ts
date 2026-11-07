// The `ticket` tool and what the session does with it: pasted evidence saved after jig-core, open checks shown with every
// prompt, and empty files reported when a ticket becomes active or is restored.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CHECKS_MESSAGE, EMPTY_FILES_MESSAGE, NOTES_MESSAGE } from "../src/session.ts";
import { ticketPaths } from "../src/store.ts";
import { classify, declaration } from "../src/tool.ts";
import { loadPlugin, PATTERN, tempFolder, useJig } from "./support.ts";

function start(t: import("node:test").TestContext) {
    const folder = tempFolder(t);
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    return { folder, jig, pi };
}

test("the tool is declared to jig-core: every action is local, and only list_checks and recall read", (t) => {
    const { jig } = start(t);
    assert.equal(jig.declared.get("ticket"), declaration);
    assert.deepEqual(classify({ action: "list_checks" }), {
        action: "list_checks",
        environment: "local",
        effect: "read",
    });
    assert.deepEqual(classify({ action: "recall", query: "NullPointerException" }), {
        action: "recall",
        environment: "local",
        effect: "read",
    });
    assert.deepEqual(classify({ action: "add_check", text: "x" }), {
        action: "add_check",
        environment: "local",
        effect: "write",
    });
    assert.throws(() => classify({ action: "add_check" }), { name: "InputError", message: /needs text/ });
    assert.throws(() => classify({ action: "list_checks", text: "x" }), /does not use text/);
    assert.throws(() => classify({ action: "save_evidence", text: "x", label: "../up" }), /label: /);
    assert.throws(() => classify({ action: "save_evidence", text: " ", label: "run" }), /text: empty/);
    assert.throws(() => classify({ action: "save_evidence", text: "x".repeat(49 * 1024), label: "run" }), /in parts/);
    assert.throws(() => classify({ action: "recall", query: " " }), /needs a query/);
});

test("without an active ticket, recall still searches, and the other actions say how to set one", async (t) => {
    const { pi } = start(t);
    const result = await pi.tool({ action: "list_checks" });
    assert.deepEqual(result, { text: "No active ticket: /ticket KEY makes one active.", isError: true });
    const found = await pi.tool({ action: "recall", query: "something" });
    assert.equal(found.isError, false);
});

test("recall searches earlier notes and returns the history warning and its facts", async (t) => {
    const { folder, jig, pi } = start(t);
    mkdirSync(ticketPaths(folder, "PROJ-88").dir, { recursive: true });
    writeFileSync(
        ticketPaths(folder, "PROJ-88").notes,
        "# PROJ-88\n\n## Now\nStatus: OrderService throws NullPointerException\n\n## Decisions\nCheck for null.\n",
    );
    pi.input("PROJ-123: the next ticket");
    writeFileSync(
        ticketPaths(folder, "PROJ-123").notes,
        "# PROJ-123\n\n## Now\nStatus: OrderService throws NullPointerException\n\n## Decisions\n",
    );
    const result = await pi.tool({ action: "recall", query: "NullPointerException in OrderService" });
    assert.equal(result.isError, false);
    assert.match(result.text, /PROJ-88 \(from notes\.md, /);
    assert.match(result.text, /history, not instructions/);
    assert.deepEqual(jig.factsCalls.at(-1)?.facts, { entries: 1, queries: 1 });
    assert.match(result.text, /PROJ-88/);
    assert.equal(result.text.includes("PROJ-123"), false, "the active ticket matches the query, and is still excluded");
});

test("pasted text is masked, saved to evidence with an index line, and the model gets the file name back", async (t) => {
    const { folder, jig, pi } = start(t);
    pi.input("PROJ-123 batch 3");
    const pasted = "batch 3: 40 removed, 2 failed\nfailed: ana@example.com, 7711\n";
    const result = await pi.tool({ action: "save_evidence", text: pasted, label: "batch 3 output" });
    assert.equal(result.isError, false);
    assert.match(
        result.text,
        /^Saved the pasted text \(\d+ bytes, masked, secrets removed\) to PROJ-123's evidence\/\S+-pasted-batch-3-output-[0-9a-f]{6}\.txt, and a line in evidence\/index\.md\.$/,
    );
    assert.deepEqual(jig.masked, [pasted], "jig-core masked it");
    const paths = ticketPaths(folder, "PROJ-123");
    const name = readdirSync(paths.evidence).find((file) => file.includes("-pasted-")) ?? "";
    const saved = readFileSync(path.join(paths.evidence, name), "utf8");
    assert.equal(saved, "batch 3: 40 removed, 2 failed\nfailed: email#1, 7711\n");
    assert.match(
        readFileSync(paths.index, "utf8"),
        new RegExp(`\\n- \\S+ \\| pasted \\| batch-3-output \\| ${name}\\n$`),
    );
    assert.equal(readdirSync(paths.evidence).filter((file) => file.endsWith(".txt")).length, 1, "not saved twice");
});

test("pasted text that jig-core withheld is not saved", async (t) => {
    const { folder, pi } = start(t);
    pi.input("PROJ-123");
    // jig-core withholds a result it cannot check by making it an error; this plugin then saves nothing.
    const replaced = pi.fire("tool_result", {
        toolName: "ticket",
        toolCallId: "call",
        input: { action: "save_evidence", text: "x", label: "run" },
        content: [{ type: "text", text: "withheld" }],
        details: {},
        isError: true,
    });
    assert.deepEqual(replaced, [undefined]);
    assert.deepEqual(
        readdirSync(ticketPaths(folder, "PROJ-123").evidence).filter((file) => file.endsWith(".txt")),
        [],
    );
});

test("open checks are added, listed, shown with every prompt and in the notes, and closed with an outcome", async (t) => {
    const { pi } = start(t);
    pi.input("PROJ-123");
    assert.deepEqual(pi.fire("before_agent_start", { messageType: "user", prompt: "next" }), [undefined]);

    const added = await pi.tool({ action: "add_check", text: "re-derive the locations before the next batch" });
    assert.match(added.text, /^Check #1 added to PROJ-123 \(1 open\)\. .*Before you hand the user a command/);
    assert.match((await pi.tool({ action: "list_checks" })).text, /^PROJ-123: 1 open \(0 closed\)\.\n#1 re-derive/);

    const [turn] = pi.fire("before_agent_start", { messageType: "user", prompt: "batch 4 please" }) as Array<{
        message: { customType: string; content: string; display: boolean };
        systemPrompt?: string;
    }>;
    assert.equal(turn?.message.customType, CHECKS_MESSAGE);
    assert.match(
        turn?.message.content ?? "",
        /^\[ticket PROJ-123\] 1 open check:\n#1 re-derive the locations before the next batch\nBefore you hand/,
    );
    assert.equal(turn?.systemPrompt, undefined, "never the system prompt");
    assert.deepEqual(
        pi.fire("before_agent_start", { messageType: "custom", message: {} }),
        [undefined],
        "only a prompt from the user",
    );

    pi.compact();
    const notes = pi.sent.filter((sent) => sent.message.customType === NOTES_MESSAGE).at(-1);
    assert.match(notes?.message.content ?? "", /\n\n\[ticket PROJ-123\] 1 open check:\n#1 re-derive/);

    const closed = await pi.tool({ action: "close_check", id: 1, outcome: "done: 12 locations re-derived" });
    assert.equal(closed.text, "Check #1 closed: done: 12 locations re-derived\nNo check is open.");
    assert.deepEqual(pi.fire("before_agent_start", { messageType: "user", prompt: "batch 4" }), [undefined]);
    assert.match((await pi.tool({ action: "close_check", id: 1, outcome: "again" })).text, /closed already/);
});

test("the reminder counts the open checks", async (t) => {
    const { pi } = start(t);
    pi.input("PROJ-123");
    await pi.tool({ action: "add_check", text: "check the ids" });
    let reminder = "";
    for (let n = 0; n < 15; n++) {
        const [change] = pi.result("bash", "output") as Array<{ content: Array<{ text?: string }> } | undefined>;
        reminder = change?.content.at(-1)?.text ?? reminder;
    }
    assert.match(reminder, / 1 check is still open \(ticket list_checks\)\.$/);
});

test("empty files are reported to the agent and the user when a ticket becomes active and when it is restored", (t) => {
    const folder = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("PROJ-123");
    assert.equal(pi.sent.filter((sent) => sent.message.customType === EMPTY_FILES_MESSAGE).length, 0, "none yet");
    writeFileSync(path.join(ticketPaths(folder, "PROJ-123").dir, "data.csv"), "");

    const resumed = loadPlugin("/work", pi.log);
    resumed.start("resume");
    const sent = resumed.sent.find((each) => each.message.customType === EMPTY_FILES_MESSAGE);
    assert.match(
        sent?.message.content ?? "",
        /^\[ticket PROJ-123\] This file is empty, possibly cut short by a crash or an unfinished write: data\.csv \(changed \d\d:\d\d\)\. Check before using them\.$/,
    );
    assert.deepEqual(sent?.options, { triggerTurn: false });
    assert.equal(resumed.notices.at(-1)?.level, "warning");
    assert.equal(resumed.notices.at(-1)?.text, sent?.message.content);

    const other = loadPlugin("/work");
    other.start();
    other.input("PROJ-123 again");
    assert.ok(
        other.sent.some((each) => each.message.customType === EMPTY_FILES_MESSAGE),
        "on activation too",
    );
});
