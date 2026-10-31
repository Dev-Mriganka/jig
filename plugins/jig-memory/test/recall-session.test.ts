import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { RECALL_MESSAGE } from "../src/session.ts";
import { ticketPaths } from "../src/store.ts";
import { loadPlugin, PATTERN, tempFolder, useJig, writeCard } from "./support.ts";

const ORDER_CARD = {
    Problem: "Cancelling an order with no customer returned 500.",
    Cause: "OrderMapper.toDto read the customer's name without a null check.",
    Fix: "The mapper returns an empty name when the customer is missing.",
};

/** A folder with one closed ticket, PROJ-88, and a Pi session over it. */
function start(t: Parameters<typeof tempFolder>[0], memory: Record<string, unknown> = {}) {
    const folder = tempFolder(t);
    writeCard(folder, "PROJ-88", ORDER_CARD, {
        repositories: ["orders-api"],
        identifiers: ["OrderMapper", "NullPointerException", "500 /orders/{id}/cancel"],
        errors: ["ERROR java.lang.NullPointerException: customer is null"],
    });
    writeCard(
        folder,
        "PROJ-61",
        {
            Problem: "The nightly report export stalled behind the warehouse sync.",
            Cause: "Both jobs wanted the same table lock.",
            Fix: "The export now starts after the sync has finished.",
        },
        { identifiers: ["ReportExporter"] },
    );
    const jig = useJig(t, { memory: { ticketPattern: PATTERN, folder, ...memory } });
    const pi = loadPlugin("/work");
    pi.start();
    return { folder, jig, pi };
}

const recalls = (pi: ReturnType<typeof start>["pi"]) => pi.sent.filter((s) => s.message.customType === RECALL_MESSAGE);
/** The tickets a recall message was about. */
const ticketsOf = (sent: { message: { details?: unknown } } | undefined): string[] =>
    (sent?.message.details as { tickets?: string[] } | undefined)?.tickets ?? [];

test("a new ticket that shares a name with a card gets one recall message, after the notes, that starts no turn", (t) => {
    const { pi } = start(t);
    pi.input("PROJ-130: cancelling fails with a NullPointerException in OrderMapper");
    assert.equal(pi.sent.length, 2);
    assert.equal(pi.sent[0]?.message.customType, "jig-memory-notes");
    const [sent] = recalls(pi);
    assert.deepEqual(sent?.options, { triggerTurn: false });
    assert.deepEqual(sent?.message.details, { key: "PROJ-130", tickets: ["PROJ-88"] });
    assert.match(
        sent?.message.content ?? "",
        /^\[recall PROJ-130\] 1 earlier ticket may relate\. Cards: .*\/<KEY>\/card\.md\. They are hints/,
    );
    assert.match(sent?.message.content ?? "", /\nPROJ-88: shares OrderMapper, NullPointerException/);
    assert.match(
        sent?.message.content ?? "",
        /\n {2}Cause: OrderMapper\.toDto read the customer's name without a null check\.\n {2}Fix: The mapper returns an empty name/,
    );
    assert.equal(pi.events.has("before_agent_start"), false, "never the system prompt");
});

test("the message names every card that passes, best first, and nothing about the ones that do not", (t) => {
    const { pi } = start(t);
    pi.input(
        "PROJ-130: the NullPointerException in OrderMapper and the ReportExporter stalled behind the warehouse sync",
    );
    const [sent] = recalls(pi);
    assert.deepEqual(ticketsOf(sent).sort(), ["PROJ-61", "PROJ-88"]);
});

test("a new ticket that matches nothing gets no recall message", (t) => {
    const { pi } = start(t);
    pi.input("PROJ-130: the footer colour is wrong on the settings page");
    assert.equal(recalls(pi).length, 0);
    assert.equal(pi.sent.length, 1);
});

test("a ticket that has notes already is not recalled for", async (t) => {
    const { folder, pi } = start(t);
    pi.input("PROJ-130: cancelling fails with a NullPointerException in OrderMapper");
    assert.equal(recalls(pi).length, 1);
    const paths = ticketPaths(folder, "PROJ-130");
    writeFileSync(paths.notes, "# PROJ-130\n\n## Now\nStatus: reproduced\n");
    await pi.command("off");
    pi.input("back to PROJ-130, NullPointerException in OrderMapper again");
    assert.equal(recalls(pi).length, 1, "still the one from before");
});

test("recall runs once per ticket per session even while its notes are still empty", async (t) => {
    const { pi } = start(t);
    pi.input("PROJ-130: cancelling fails with a NullPointerException in OrderMapper");
    await pi.command("off");
    await pi.command("PROJ-130");
    assert.equal(recalls(pi).length, 1);
});

test("/ticket KEY has no message, so recall goes by the key alone", async (t) => {
    const folder = tempFolder(t);
    writeCard(folder, "PROJ-88", ORDER_CARD, { keys: ["PROJ-130"] });
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    await pi.command("PROJ-130");
    const [sent] = recalls(pi);
    assert.match(sent?.message.content ?? "", /\nPROJ-88: shares PROJ-130\n/);
});

test("recall.enabled false stops the automatic run, and /ticket recall still works", async (t) => {
    const { pi } = start(t, { recall: { enabled: false } });
    pi.input("PROJ-130: cancelling fails with a NullPointerException in OrderMapper");
    assert.equal(recalls(pi).length, 0);
    await pi.command("recall NullPointerException in OrderMapper");
    assert.match(pi.notices.at(-1)?.text ?? "", /^Related earlier tickets \(2 cards searched\):\n\nPROJ-88: shares/);
});

test("recall.max and recall.minScore are honoured", (t) => {
    const folder = tempFolder(t);
    for (const key of ["PROJ-1", "PROJ-2", "PROJ-3", "PROJ-4"])
        writeCard(folder, key, ORDER_CARD, { keys: ["PROJ-9"] });
    useJig(t, { memory: { ticketPattern: PATTERN, folder, recall: { max: 2 } } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("PROJ-9 is new");
    const [sent] = recalls(pi);
    assert.equal(ticketsOf(sent).length, 2);
});

test("a recall that finds nothing sends nothing even when the index is missing or the folder is new", (t) => {
    const folder = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("PROJ-1 is new");
    assert.equal(recalls(pi).length, 0);
    assert.equal(
        pi.notices.some((notice) => notice.level === "warning"),
        false,
    );
});

test("a restored ticket is not recalled for", (t) => {
    const { pi, folder } = start(t);
    pi.input("PROJ-130: NullPointerException in OrderMapper");
    const resumed = loadPlugin("/work", pi.log);
    resumed.start("resume");
    assert.equal(recalls(resumed).length, 0);
    assert.equal(existsSync(ticketPaths(folder, "PROJ-130").dir), true);
});

test("/ticket recall with text shows the result to the user and sends nothing to the agent", async (t) => {
    const { pi } = start(t);
    await pi.command("recall the report export stalled behind the warehouse sync again");
    assert.equal(pi.sent.length, 0);
    assert.match(pi.notices.at(-1)?.text ?? "", /^Related earlier tickets \(2 cards searched\):\n\nPROJ-61: words: /);
});

test("/ticket recall on the active ticket reads its notes and evidence", async (t) => {
    const { folder, pi } = start(t);
    pi.input("PROJ-130: something fails");
    const paths = ticketPaths(folder, "PROJ-130");
    writeFileSync(paths.notes, "# PROJ-130\n\n## Now\nStatus: looking at the mapper\n\n## Decisions\n");
    pi.result("logs", "10:00:00 ERROR java.lang.NullPointerException: customer is null", { action: "query" });
    await pi.command("recall");
    assert.match(
        pi.notices.at(-1)?.text ?? "",
        /PROJ-88: shares NullPointerException; same error "ERROR java\.lang\.NullPointerException: customer is null"/,
    );
    assert.equal(recalls(pi).length, 0, "by hand, the agent is not told");
});

test("/ticket recall says so when there is no ticket, no cards, or nothing that scores enough", async (t) => {
    const { pi } = start(t);
    await pi.command("recall");
    assert.equal(
        pi.notices.at(-1)?.text,
        "No active ticket. Use /ticket recall <text>, or make a ticket active first.",
    );
    await pi.command("recall the footer colour is wrong on the settings page");
    assert.equal(pi.notices.at(-1)?.text, "No earlier ticket scores 2 or more among 2 cards.");

    const empty = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder: empty } });
    const bare = loadPlugin("/work");
    bare.start();
    await bare.command("recall anything");
    assert.equal(bare.notices.at(-1)?.text, "No cards yet: /ticket close writes one for a ticket.");
});

test("a card closed in this session is found by the next new ticket", async (t) => {
    const folder = tempFolder(t);
    useJig(t, { memory: { ticketPattern: PATTERN, folder } });
    const pi = loadPlugin("/work");
    pi.start();
    pi.input("PROJ-1: cancelling fails in OrderMapper");
    pi.result("logs", "ERROR java.lang.NullPointerException: customer is null in OrderMapper", { action: "query" });
    await pi.command("close");
    writeCard(folder, "PROJ-1", ORDER_CARD, {
        identifiers: ["OrderMapper", "NullPointerException"],
        errors: ["ERROR java.lang.NullPointerException: customer is null in OrderMapper"],
    });
    pi.settle();
    pi.input("PROJ-2: a NullPointerException in OrderMapper again");
    const [sent] = recalls(pi);
    assert.match(sent?.message.content ?? "", /\nPROJ-1: shares OrderMapper, NullPointerException/);
});
