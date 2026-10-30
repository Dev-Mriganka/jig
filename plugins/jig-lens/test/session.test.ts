// The plugin in a real Pi session (the SDK, with its scripted "faux" model): `/lens` is run the way a user runs it, and
// then the model is asked something, to see what Pi sends it. This is the check that the summary stays out of the
// conversation, made against Pi itself and not against the fake in the other tests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ENTRY } from "../src/display.ts";
import type { SummaryEntry } from "../src/display.ts";
import { lens } from "../src/index.ts";
import { plain } from "../src/summary.ts";
import { NOW, tempState, writeSample } from "./support.ts";

/** A session with the plugin loaded and a screen that records what it is told. */
async function session(t: TestContext) {
    const state = tempState(t);
    writeSample(state);
    const root = mkdtempSync(path.join(tmpdir(), "jig-lens-session-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "work");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const modelRuntime = await ModelRuntime.create({
        authPath: path.join(root, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(root, "store.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    const faux = fauxProvider();
    modelRuntime.registerNativeProvider(faux.provider);
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        extensionFactories: [lens({ env: { JIG_STATE_DIR: state, PATH: "" }, now: () => NOW })],
        noExtensions: false,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model: faux.getModel(),
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    });
    const notices: string[] = [];
    const ui = { notify: (message: string) => notices.push(message) } as unknown as ExtensionUIContext;
    await session.bindExtensions({ uiContext: ui, mode: "tui" });
    t.after(async () => {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
        if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
        rmSync(root, { recursive: true, force: true });
    });
    return { session, faux, notices };
}

test("in a real session /lens leaves an entry in the session, and the model is never sent it", async (t) => {
    const { session: pi, faux, notices } = await session(t);
    const messagesBefore = pi.messages.length;

    await pi.prompt("/lens days 7");

    // The command ran in Pi: the summary is in the session, as a custom entry, and was said nowhere else.
    const entries = pi.sessionManager.getEntries().filter((entry) => entry.type === "custom");
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry?.type === "custom" ? entry.customType : undefined, ENTRY);
    const text = plain(entry?.type === "custom" ? (entry.data as SummaryEntry).blocks : []);
    assert.match(text, /Last 7 days, 2026-10-24 to 2026-10-30/);
    assert.match(text, /\$0\.46 over 6 turns/);
    assert.deepEqual(notices, [], "a terminal draws the entry, so there is no notification");
    assert.equal(pi.messages.length, messagesBefore, "the command added nothing to the conversation");
    assert.equal(faux.state.callCount, 0, "and did not ask the model anything");

    // Now the user talks to the model. Whatever Pi sends it, it holds none of the summary.
    let sent = "";
    faux.setResponses([
        (context) => {
            sent = JSON.stringify(context);
            return fauxAssistantMessage("hello");
        },
    ]);
    await pi.prompt("what did the tests say?");
    assert.equal(faux.state.callCount, 1);
    assert.match(sent, /what did the tests say\?/, "the model was sent the question");
    for (const word of ["read from cache", "Your time", "Last 7 days", "model-a", "flow test", "jig-lens-summary"]) {
        assert.ok(!sent.includes(word), `the model was sent "${word}"`);
    }
    // And Pi's own view of the conversation, which is what it rebuilds the context from, has no such entry either.
    const conversation = JSON.stringify(pi.sessionManager.buildSessionContext().messages);
    assert.ok(!conversation.includes("read from cache"));
});

test("in a real session every scope of /lens does the same, and a bad word says what is wrong", async (t) => {
    const { session: pi, faux, notices } = await session(t);
    for (const args of ["", "ticket T-1", "session", "days 1"]) await pi.prompt(`/lens ${args}`.trim());
    assert.equal(pi.sessionManager.getEntries().filter((entry) => entry.type === "custom").length, 4);
    await pi.prompt("/lens days 400");
    assert.deepEqual(notices, [
        "/lens days takes a whole number from 1 to 90.\n" +
            "Usage: /lens [ticket KEY | session [id] | days N | grafana | datasette | rebuild | status]",
    ]);
    assert.equal(faux.state.callCount, 0, "no command asked the model anything");
    assert.equal(pi.sessionManager.getEntries().filter((entry) => entry.type === "custom").length, 4);
});
