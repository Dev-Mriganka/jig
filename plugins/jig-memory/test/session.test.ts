import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import factory from "../src/index.ts";
import { NOTES_MESSAGE, TICKET_ENTRY } from "../src/session.ts";
import { ticketPaths } from "../src/store.ts";
import { changed, FakePi, loadPlugin, PATTERN, tempFolder, useJig } from "./support.ts";

const read = (file: string) => readFileSync(file, "utf8");
const tickets = (folder: string) => ticketPaths(folder, "ACME-1");

/** Every file under `dir`, as text: what a search for a secret would find. */
function allText(dir: string): string {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
        .map((name) => path.join(dir, name))
        .filter((file) => statSync(file).isFile())
        .map((file) => read(file))
        .join("\n");
}

test("the factory registers the memory section with its check, even when jig-core loads later", (t) => {
    const pi = new FakePi("/work");
    factory(pi.api);
    const jig = useJig(t);
    const check = jig.checks.get("memory");
    assert.ok(check, "registered once jig-core is published");
    assert.deepEqual(check({ ticketPatern: PATTERN }), ["memory.ticketPatern: unknown field"]);
});

test("a message that names a ticket activates it: folder, jig-core, a recorded entry, and the notes as a message", (t) => {
    const folder = tempFolder(t);
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("debug ACME-12, the export fails");

    assert.deepEqual(jig.tickets, ["ACME-12"]);
    assert.ok(existsSync(path.join(folder, "ACME-12", "notes.md")));
    assert.deepEqual(pi.log.filter((entry) => entry.type === "custom"), [{ type: "custom", customType: TICKET_ENTRY, data: { key: "ACME-12" } }]);
    assert.equal(pi.sent.length, 1);
    const [sent] = pi.sent;
    assert.deepEqual(sent?.options, { triggerTurn: false }, "appended, no model turn started");
    assert.equal(sent?.message.customType, NOTES_MESSAGE);
    assert.deepEqual(sent?.message.details, { key: "ACME-12" });
    assert.match(sent?.message.content ?? "", /^\[ticket ACME-12\] Active\. Folder: .*ACME-12\/ \(notes\.md, evidence\/index\.md\)\.\n\n# ACME-12\n/);
    assert.equal(pi.notices.at(-1)?.text, `Ticket ACME-12 active (named in your message). Folder: ${path.join(folder, "ACME-12")}/`);
});

test("text that names no ticket, or a key glued to a letter, activates nothing", (t) => {
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder: tempFolder(t) } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("the export fails");
    pi.input("aACME-12 is not a key");
    assert.deepEqual(jig.tickets, []);
    assert.equal(pi.sent.length, 0);
});

test("a message sent by an extension is not the user's words, so it activates nothing", (t) => {
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder: tempFolder(t) } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("ACME-12 finished", "extension");
    assert.deepEqual(jig.tickets, []);
    assert.equal(pi.sent.length, 0);
});

test("without a ticketPattern only /ticket KEY activates a ticket", async (t) => {
    const folder = tempFolder(t);
    const jig = useJig(t, { memory: { folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("debug ACME-12");
    assert.deepEqual(jig.tickets, []);
    await pi.command("ACME-12");
    assert.deepEqual(jig.tickets, ["ACME-12"]);
});

test("several tickets named with none active ask for a choice and activate nothing", (t) => {
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder: tempFolder(t) } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("compare ACME-2 with ACME-3");
    assert.equal(pi.notices.at(-1)?.text, "Several tickets named (ACME-2, ACME-3): run /ticket <KEY> to choose one.");
    assert.deepEqual(jig.tickets, []);
    assert.equal(pi.sent.length, 0);
});

test("naming another ticket while one is active does not switch; each hint is said once", (t) => {
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder: tempFolder(t) } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("look at ACME-1");
    pi.input("is ACME-9 related?");
    assert.equal(pi.notices.at(-1)?.text, "ACME-9 mentioned; /ticket ACME-9 switches");
    const shown = pi.notices.length;
    pi.input("and ACME-9 again");
    assert.equal(pi.notices.length, shown, "the same hint is not repeated");
    pi.input("compare ACME-2 with ACME-3");
    assert.equal(pi.notices.at(-1)?.text, "ACME-2, ACME-3 mentioned; /ticket <KEY> switches");
    pi.input("ACME-1 and ACME-4");
    assert.deepEqual(jig.tickets, ["ACME-1"], "the active ticket was never switched");
});

test("/ticket shows the active ticket, sets one explicitly, and off clears it; a later message can name another", async (t) => {
    const folder = tempFolder(t);
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    await pi.command("");
    assert.equal(pi.notices.at(-1)?.text, "No active ticket. Run /ticket KEY, or name a ticket in your message.");
    await pi.command("ACME-1");
    assert.deepEqual(jig.tickets, ["ACME-1"]);
    await pi.command("");
    assert.equal(pi.notices.at(-1)?.text, `Ticket ACME-1: notes ${tickets(folder).notes}, 0 saved results.`);
    await pi.command("off");
    assert.deepEqual(jig.tickets, ["ACME-1", undefined]);
    assert.deepEqual(pi.log.filter((entry) => entry.type === "custom").map((entry) => entry.data), [{ key: "ACME-1" }, { key: null }]);
    pi.input("ACME-2 next");
    assert.deepEqual(jig.tickets, ["ACME-1", undefined, "ACME-2"]);
});

test("/ticket KEY for the active ticket says so; for another it switches with the notes", async (t) => {
    const jig = useJig(t, { memory: { folder: tempFolder(t) } });
    const pi = loadPlugin("/work");
    pi.start();
    await pi.command("ACME-1");
    await pi.command("ACME-1");
    assert.equal(pi.notices.at(-1)?.text, "Ticket ACME-1 is already active.");
    await pi.command("ACME-3");
    assert.deepEqual(jig.tickets, ["ACME-1", "ACME-3"]);
    assert.equal(pi.sent.length, 2);
});

test("a value that is not a ticket key is refused, and the refusal says how to use the command", async (t) => {
    const jig = useJig(t, { memory: { folder: tempFolder(t) } });
    const pi = loadPlugin("/work");
    pi.start();
    for (const arg of ["ACME 1", "../x"]) {
        await pi.command(arg);
        assert.equal(pi.notices.at(-1)?.level, "warning", arg);
        assert.match(pi.notices.at(-1)?.text ?? "", /^Use \/ticket KEY, \/ticket off, or \/ticket alone/);
    }
    assert.deepEqual(jig.tickets, []);
});

test("the ticket is restored on session_start from the branch, and its notes are not sent again", async (t) => {
    const folder = tempFolder(t);
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const first = loadPlugin("/work");
    first.start();
    first.input("continue ACME-5");
    const resumed = loadPlugin("/work", first.log);
    resumed.start("resume");
    assert.deepEqual(jig.tickets, ["ACME-5", "ACME-5"]);
    assert.equal(resumed.notices.at(-1)?.text, "Ticket ACME-5 restored from this session.");
    assert.equal(resumed.sent.length, 0, "the session already holds the notes message");
    resumed.input("and then?");
    assert.equal(resumed.sent.length, 0);
});

test("a ticket turned off before the session ended is not restored", async (t) => {
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder: tempFolder(t) } });
    const first = loadPlugin("/work");
    first.start();
    first.input("ACME-5");
    await first.command("off");
    const resumed = loadPlugin("/work", first.log);
    resumed.start("resume");
    assert.deepEqual(jig.tickets, ["ACME-5", undefined], "nothing new is told to jig-core");
    assert.equal(resumed.notices.length, 0);
});

test("the default folder is under XDG_DATA_HOME when jig.json has no memory section", async (t) => {
    const saved = process.env.XDG_DATA_HOME;
    t.after(() => {
        if (saved === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = saved;
    });
    const xdg = tempFolder(t);
    process.env.XDG_DATA_HOME = xdg;
    const jig = useJig(t, {});
    const pi = loadPlugin("/work");
    pi.start();
    assert.deepEqual(jig.reads, ["memory"], "the section is read at session start");
    await pi.command("ACME-9");
    assert.ok(existsSync(path.join(xdg, "jig", "tickets", "ACME-9", "notes.md")));
});

test("the fifteenth tool result carries a reminder to update ## Now, and the count starts again", (t) => {
    const folder = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("look at ACME-3");
    for (let n = 1; n < 15; n++) assert.equal(changed(pi.result("bash", `r${n}`)), undefined, `result ${n}`);
    const fifteenth = changed(pi.result("bash", "r15"));
    assert.ok(fifteenth, "the reminder");
    assert.equal(fifteenth.content[0]?.text, "r15", "the tool's own text is kept");
    assert.match(fifteenth.content.at(-1)?.text ?? "", /^\[ticket ACME-3\] 15 tool results since notes\.md last changed: update the ## Now block in .*ACME-3\/notes\.md/);
    for (let n = 16; n < 30; n++) assert.equal(changed(pi.result("bash", `r${n}`)), undefined, `result ${n}`);
    assert.ok(changed(pi.result("bash", "r30")), "the next reminder, fifteen results later");
});

test("a change to notes.md restarts the count, and the edit that made it does not count", (t) => {
    const folder = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("look at ACME-3");
    const notes = ticketPaths(folder, "ACME-3").notes;
    for (let n = 0; n < 10; n++) pi.result("bash", "output");
    writeFileSync(notes, read(notes).replace("Status: new", "Status: reproduced"));
    assert.equal(changed(pi.result("edit", "Edited.", { path: notes })), undefined, "the edit is not counted");
    for (let n = 1; n < 15; n++) assert.equal(changed(pi.result("bash", "output")), undefined, `after the edit, result ${n}`);
    assert.ok(changed(pi.result("bash", "output")), "the fifteenth result after the edit");
});

test("a result of a tool other than Pi's file tools is evidence while the ticket is active, with its action", (t) => {
    const folder = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.result("logs", "before any ticket", { action: "query" });
    assert.equal(existsSync(path.join(folder, "ACME-4")), false, "no ticket, no folder");
    pi.input("look at ACME-4");
    pi.result("logs", "131 hits", { action: "query", env: "staging" });
    const paths = ticketPaths(folder, "ACME-4");
    assert.match(read(paths.index), /^- \S+ \| logs \| query \| \S+-logs-query-[0-9a-f]{6}\.txt$/m);
    const [saved] = readdirSync(paths.evidence).filter((name) => name.endsWith(".txt"));
    assert.equal(readdirSync(paths.evidence).filter((name) => name.endsWith(".txt")).length, 1);
    assert.equal(read(path.join(paths.evidence, saved ?? "")), "131 hits");
});

test("Pi's file tools add no evidence, but a secret in a tool's arguments is never stored", (t) => {
    const folder = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("look at ACME-1");
    for (const tool of ["read", "ls", "find", "grep", "write", "edit"]) pi.result(tool, "file text", { path: "notes.md" });
    const paths = tickets(folder);
    assert.equal(readdirSync(paths.evidence).filter((name) => name.endsWith(".txt")).length, 0);
    assert.doesNotMatch(read(paths.index), /\n- /);
    pi.result("logs", "ok", { action: "query", token: "SECRET-VALUE-1" });
    assert.doesNotMatch(allText(folder), /SECRET-VALUE-1/);
});

test("an agent edit that leaves ## Now over 1 KB moves its older lines to history", (t) => {
    const folder = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("look at ACME-6");
    const paths = ticketPaths(folder, "ACME-6");
    const findings = Array.from({ length: 40 }, (_, n) => `- finding ${n}: ${"x".repeat(40)}`).join("\n");
    writeFileSync(paths.notes, read(paths.notes).replace("Open questions:\n", `Open questions:\n${findings}\n`));
    pi.result("edit", "Edited.", { path: paths.notes });
    const [history] = readdirSync(paths.history);
    assert.equal(readdirSync(paths.history).length, 1);
    assert.match(read(path.join(paths.history, history ?? "")), /- finding 39: /);
    const notes = read(paths.notes);
    assert.ok(Buffer.byteLength(notes.slice(notes.indexOf("## Now"), notes.indexOf("## Decisions"))) < 1024);
});

test("after a compaction the current notes come back as a message, and the system prompt is never touched", (t) => {
    const folder = tempFolder(t);
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("look at ACME-7");
    const paths = ticketPaths(folder, "ACME-7");
    writeFileSync(paths.notes, read(paths.notes).replace("Status: new", "Status: root cause found"));
    pi.compact();
    assert.equal(pi.sent.length, 2);
    const [, sent] = pi.sent;
    assert.deepEqual(sent?.options, { triggerTurn: false });
    assert.match(sent?.message.content ?? "", /^\[ticket ACME-7\] Still active after compaction; current notes follow\. Folder: .*ACME-7\/ \(notes\.md, evidence\/index\.md\)\.\n\n# ACME-7\n\n## Now\nStatus: root cause found/);
    assert.equal(pi.events.has("before_agent_start"), false, "no hook changes the system prompt");
    assert.deepEqual(jig.tickets, ["ACME-7"], "a compaction does not change the ticket");
});

test("without a ticket, a compaction sends nothing", (t) => {
    useJig(t, { memory: { folder: tempFolder(t) } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.compact();
    assert.equal(pi.sent.length, 0);
});

test("a result that cannot be saved is a warning with the reason, and the tool's result is untouched", (t) => {
    const folder = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("look at ACME-6");
    const paths = ticketPaths(folder, "ACME-6");
    rmSync(paths.evidence, { recursive: true });
    writeFileSync(paths.evidence, "not a folder");
    assert.deepEqual(pi.result("logs", "x", { action: "query" }), [undefined]);
    assert.equal(pi.notices.at(-1)?.level, "warning");
    assert.match(pi.notices.at(-1)?.text ?? "", /^Could not save evidence for ACME-6: /);
});
