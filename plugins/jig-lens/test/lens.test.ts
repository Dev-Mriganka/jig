// The import at the end of a run, the viewer commands and the rest, with a fake Pi and fake programs: nothing here
// starts Grafana or opens a browser. The summaries are in routing.test.ts and display.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { lens } from "../src/index.ts";
import { START_ATTEMPTS, START_WAIT_MS } from "../src/start.ts";
import { openIndex, readStatus } from "../src/store.ts";
import { appendLines, FakePi, rig, text, turn, useJig, writeSample } from "./support.ts";

const INDEX_LINE = /^Index: .*\/lens\/index\.sqlite, \d+(\.\d)? (B|KB|MB), 14 calls and 6 turns from 4 record files$/;

// ---- /lens status ---------------------------------------------------------------------------------------------------

test("/lens status before anything was imported says there is no index yet", async (t) => {
    const r = rig(t, { answers: ["stopped"] });
    const notices = await r.pi.lens("status");
    assert.deepEqual(notices, [
        {
            level: "info",
            text: [
                "Viewer: none running at http://127.0.0.1:3300 (/lens grafana or /lens datasette starts one)",
                `Index: none yet at ${r.where.index}. It is made when an agent run ends, and by /lens.`,
                "Last import: never",
            ].join("\n"),
        },
    ]);
});

test("/lens status gives the viewer's address and state, the index size, the last import and skips", async (t) => {
    const r = rig(t, { answers: ["running"] });
    writeSample(r.state);
    await r.pi.fire("agent_end");
    const [notice, ...more] = await r.pi.lens("status");
    assert.equal(more.length, 0);
    assert.equal(notice?.level, "info");
    const lines = notice?.text.split("\n") ?? [];
    assert.equal(lines[0], "Viewer: grafana at http://127.0.0.1:3300, running");
    assert.match(lines[1] ?? "", INDEX_LINE);
    assert.equal(lines[2], "Last import: 2026-10-30 12:00:00 UTC");
    assert.equal(lines[3], "Skipped lines: none");
    assert.equal(lines.length, 4);
});

test("/lens status counts the lines that could not be read, by file", async (t) => {
    const r = rig(t, { answers: ["running"] });
    writeSample(r.state);
    appendLines(r.state, "2026-10-29", ["not a record"]);
    appendLines(r.state, "2026-10-30", ["{}", "also not"]);
    await r.pi.fire("agent_end");
    const lines = (await r.pi.lens("status"))[0]?.text.split("\n") ?? [];
    assert.equal(lines[3], "Skipped lines: 3 (2026-10-29.jsonl: 1, 2026-10-30.jsonl: 2)");
});

test("/lens status says when the port is taken by something that is neither viewer", async (t) => {
    const r = rig(t, { answers: ["busy"] });
    const first = (await r.pi.lens("status"))[0]?.text.split("\n")[0];
    assert.equal(
        first,
        "Viewer: the port is taken by something that is neither Grafana nor Datasette (http://127.0.0.1:3300)",
    );
    assert.deepEqual(r.probes, [
        ["grafana", 3300],
        ["datasette", 3300],
    ]);
});

test("/lens status asks for Grafana first, and for Datasette only when something else answers", async (t) => {
    const r = rig(t, { answers: { grafana: ["busy"], datasette: ["running"] }, settings: () => ({ port: 4100 }) });
    const first = (await r.pi.lens("status"))[0]?.text.split("\n")[0];
    assert.equal(first, "Viewer: datasette at http://127.0.0.1:4100, running");
    assert.deepEqual(
        r.probes,
        [
            ["grafana", 4100],
            ["datasette", 4100],
        ],
        "on the port that is set",
    );
});

test("/lens status asks once when nothing answers: the port is the same for both viewers", async (t) => {
    const r = rig(t, { answers: ["stopped"] });
    await r.pi.lens("status");
    assert.deepEqual(r.probes, [["grafana", 3300]]);
});

test("/lens status starts nothing and opens nothing", async (t) => {
    const r = rig(t, { answers: ["stopped"] });
    await r.pi.lens("status");
    assert.deepEqual([r.spawned, r.opened], [[], []]);
});

test("/lens status says so when the index cannot be read, and what to do", async (t) => {
    const r = rig(t, { answers: ["running"] });
    mkdirSync(r.where.lens, { recursive: true });
    writeFileSync(
        r.where.index,
        "this is not a database, and it is long enough that SQLite reads a header from it".repeat(10),
    );
    const lines = (await r.pi.lens("status"))[0]?.text.split("\n") ?? [];
    assert.match(lines[1] ?? "", /^Index: .*index\.sqlite cannot be read \(.*\)\. \/lens rebuild makes it again\.$/);
});

// ---- the import at the end of a run ---------------------------------------------------------------------------------

test("the import runs when an agent run ends, and says nothing when it goes well", async (t) => {
    const r = rig(t);
    writeSample(r.state);
    await r.pi.fire("agent_end", { messages: [] });
    assert.deepEqual(r.pi.notices, []);
    assert.equal(readStatus(r.where.index)?.calls, 14);
    appendLines(r.state, "2026-10-30", [JSON.stringify({ kind: "turn" })]);
    await r.pi.fire("agent_end");
    assert.equal(readStatus(r.where.index)?.calls, 14, "a second run changes nothing that did not change");
});

test("each run that ends brings in the records written since", async (t) => {
    const r = rig(t);
    writeSample(r.state);
    await r.pi.fire("agent_end");
    assert.equal(readStatus(r.where.index)?.turns, 6);
    appendLines(r.state, "2026-10-30", [JSON.stringify(turn("late", "2026-10-30T11:00:00Z", "s2", "model-a", 0.5))]);
    await r.pi.fire("agent_end");
    assert.equal(readStatus(r.where.index)?.turns, 7);
});

test("an import that fails is told once, with the reason, and never throws into Pi", async (t) => {
    const r = rig(t);
    writeSample(r.state);
    mkdirSync(r.where.lens, { recursive: true });
    writeFileSync(
        r.where.index,
        "this is not a database, and it is long enough that SQLite reads a header from it".repeat(10),
    );
    await r.pi.fire("agent_end");
    await r.pi.fire("agent_end");
    assert.equal(r.pi.notices.length, 1, "the same failure is not repeated");
    assert.equal(r.pi.notices[0]?.level, "warning");
    assert.match(r.pi.notices[0]?.text ?? "", /^jig-lens could not import the records: /);
});

test("a failure that was fixed and then comes back is told again", async (t) => {
    const r = rig(t);
    writeSample(r.state);
    const corrupt = () => {
        mkdirSync(r.where.lens, { recursive: true });
        writeFileSync(
            r.where.index,
            "this is not a database, and it is long enough that SQLite reads a header from it".repeat(10),
        );
    };
    corrupt();
    await r.pi.fire("agent_end");
    assert.equal(r.pi.notices.length, 1);
    await r.pi.lens("rebuild");
    const after = r.pi.notices.length;
    await r.pi.fire("agent_end");
    assert.equal(r.pi.notices.length, after, "all well again, and nothing to say");
    // Its files are gone, so it can be made corrupt again.
    openIndex(r.where.index).close();
    corrupt();
    await r.pi.fire("agent_end");
    assert.equal(r.pi.notices.at(-1)?.level, "warning");
});

test("an import with no screen to tell does not fail", async (t) => {
    const r = rig(t, { mode: "print" });
    writeSample(r.state);
    await r.pi.fire("agent_end");
    assert.equal(readStatus(r.where.index)?.calls, 14);
    assert.deepEqual(r.pi.notices, []);
});

// ---- /lens grafana and /lens datasette: start and open --------------------------------------------------------------

test("/lens grafana starts Grafana with exactly this command: loopback, sign-in on, no admin password", async (t) => {
    const r = rig(t);
    writeSample(r.state);
    await r.pi.lens("grafana");
    assert.equal(r.spawned.length, 1);
    assert.deepEqual(r.spawned[0], {
        file: "/usr/bin/grafana",
        args: ["server"],
        env: {
            PATH: "/usr/bin:/bin",
            HOME: "/home/me",
            GF_SERVER_HTTP_ADDR: "127.0.0.1",
            GF_SERVER_HTTP_PORT: "3300",
            GF_PATHS_DATA: r.where.grafanaData,
            GF_PATHS_PROVISIONING: r.where.provisioning,
            GF_AUTH_ANONYMOUS_ENABLED: "false",
            GF_ANALYTICS_REPORTING_ENABLED: "false",
            GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
            GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false",
            GF_ANALYTICS_FEEDBACK_LINKS_ENABLED: "false",
            GF_NEWS_NEWS_FEED_ENABLED: "false",
            GF_SECURITY_DISABLE_GRAVATAR: "true",
            GF_PLUGINS_PREINSTALL_DISABLED: "true",
            GF_LOG_MODE: "console",
            JIG_LENS_INDEX: r.where.index,
            JIG_LENS_DASHBOARDS: r.where.dashboards,
        },
        cwd: r.where.lens,
        log: r.where.log,
    });
    const env: Record<string, string> = r.spawned[0]?.env ?? {};
    assert.equal(env.GF_SERVER_HTTP_ADDR, "127.0.0.1");
    assert.equal(env.GF_AUTH_ANONYMOUS_ENABLED, "false");
    for (const name of [
        "REPORTING_ENABLED",
        "CHECK_FOR_UPDATES",
        "CHECK_FOR_PLUGIN_UPDATES",
        "FEEDBACK_LINKS_ENABLED",
    ]) {
        assert.equal(env[`GF_ANALYTICS_${name}`], "false", name);
    }
    assert.deepEqual(
        Object.keys(env).filter((name) => /ADMIN|PASSWORD|API_KEY/i.test(name)),
        [],
    );
});

test("/lens grafana tells what it did, and opens the overview dashboard in the browser", async (t) => {
    const r = rig(t);
    writeSample(r.state);
    const notices = await r.pi.lens("grafana");
    assert.deepEqual(
        notices.map((notice) => notice.level),
        ["info"],
    );
    assert.deepEqual(notices[0]?.text.split("\n"), [
        "Imported 14 new calls and 6 new turns.",
        "Grafana started (process 4242) at http://127.0.0.1:3300.",
        "First start: sign in as admin (Grafana's initial password is admin) and choose a new password when it asks.",
        "Do not skip that: until you do, any program on this machine can sign in.",
        "If the dashboards report that the data source plugin is missing, run " +
            "grafana cli plugins install frser-sqlite-datasource and start Grafana again.",
        "Opened http://127.0.0.1:3300/d/jig-overview in your browser.",
    ]);
    assert.deepEqual(r.opened, ["http://127.0.0.1:3300/d/jig-overview"]);
});

test("/lens grafana imports before it starts the viewer, so the dashboard has the records when it opens", async (t) => {
    let rowsWhenStarted: number | undefined;
    const r = rig(t, { onSpawn: (where) => (rowsWhenStarted = readStatus(where.index)?.calls) });
    writeSample(r.state);
    await r.pi.lens("grafana");
    assert.equal(rowsWhenStarted, 14);
});

test("Grafana's data folder is made private, and the first-start note comes only once", async (t) => {
    const r = rig(t, { answers: ["stopped", "running", "stopped", "running"] });
    await r.pi.lens("grafana");
    assert.equal(statSync(r.where.grafanaData).mode & 0o777, 0o700);
    assert.match(text(r.pi.notices), /First start: sign in as admin/);

    writeFileSync(path.join(r.where.grafanaData, "grafana.db"), "");
    const second = text(await r.pi.lens("grafana"));
    assert.doesNotMatch(second, /First start/);
    assert.match(second, /Grafana started \(process 4242\) at http:\/\/127\.0\.0\.1:3300\./);
});

test("/lens grafana waits for the viewer to answer, a little at a time", async (t) => {
    const r = rig(t, { answers: ["stopped", "stopped", "stopped", "stopped", "running"] });
    const notices = await r.pi.lens("grafana");
    assert.equal(notices[0]?.level, "info");
    assert.deepEqual(r.slept, [START_WAIT_MS, START_WAIT_MS, START_WAIT_MS], "three waits, then it answered");
    assert.equal(r.opened.length, 1);
});

test("/lens grafana does not start a viewer that is already running, and still opens the dashboard", async (t) => {
    const r = rig(t, { answers: ["running"] });
    writeSample(r.state);
    const notices = await r.pi.lens("grafana");
    assert.deepEqual(r.spawned, []);
    assert.deepEqual(notices[0]?.text.split("\n"), [
        "Imported 14 new calls and 6 new turns.",
        "Opened http://127.0.0.1:3300/d/jig-overview in your browser.",
    ]);
    assert.deepEqual(r.opened, ["http://127.0.0.1:3300/d/jig-overview"]);
    const again = await r.pi.lens("grafana");
    assert.equal(again[0]?.text.split("\n")[0], "The index is up to date.");
});

test("when no browser can be found, /lens grafana gives the address to open", async (t) => {
    const r = rig(t, { answers: ["running"], opens: false });
    const lines = (await r.pi.lens("grafana"))[0]?.text.split("\n") ?? [];
    assert.equal(lines.at(-1), "Open http://127.0.0.1:3300/d/jig-overview in your browser.");
});

test("/lens datasette starts Datasette with exactly this command, and opens its page for the index", async (t) => {
    const r = rig(t, { settings: () => ({ port: 4100 }) });
    writeSample(r.state);
    const notices = await r.pi.lens("datasette");
    assert.deepEqual(r.spawned, [
        {
            file: "/usr/bin/datasette",
            args: [r.where.index, "--host", "127.0.0.1", "--port", "4100", "--metadata", r.where.datasetteMetadata],
            env: { PATH: "/usr/bin:/bin", HOME: "/home/me" },
            cwd: r.where.lens,
            log: r.where.log,
        },
    ]);
    assert.ok(existsSync(r.where.datasetteMetadata), "the metadata it is given is a file of this plugin");
    assert.deepEqual(r.opened, ["http://127.0.0.1:4100/index"]);
    assert.deepEqual(notices[0]?.text.split("\n"), [
        "Imported 14 new calls and 6 new turns.",
        "Datasette started (process 4242) at http://127.0.0.1:4100.",
        "Opened http://127.0.0.1:4100/index in your browser.",
    ]);
});

test("without Grafana, /lens grafana says how to install it and the plugin, and mentions Datasette", async (t) => {
    const r = rig(t, { installed: {} });
    const notices = await r.pi.lens("grafana");
    assert.equal(notices[0]?.level, "warning");
    assert.deepEqual(notices[0]?.text.split("\n").slice(1), [
        "Grafana is not installed: there is no grafana or grafana-server on PATH.",
        "Install Grafana OSS with your package manager (Homebrew on macOS), then add its SQLite data source:",
        "  grafana cli plugins install frser-sqlite-datasource",
        "and run /lens grafana again.",
        "Datasette shows the same index. Install it with pip (pip install datasette) and run /lens datasette.",
    ]);
    assert.deepEqual([r.spawned, r.opened], [[], []]);
});

test("the older grafana-server is used when it is the only Grafana", async (t) => {
    const r = rig(t, { installed: { "grafana-server": "/usr/sbin/grafana-server" } });
    await r.pi.lens("grafana");
    assert.equal(r.spawned[0]?.file, "/usr/sbin/grafana-server");
    assert.deepEqual(r.spawned[0]?.args, []);
});

test("without Datasette, /lens datasette says how to install it, and starts nothing", async (t) => {
    const r = rig(t, { installed: { grafana: "/usr/bin/grafana" } });
    const notices = await r.pi.lens("datasette");
    assert.equal(notices[0]?.level, "warning");
    assert.match(text(notices), /Datasette is not installed: there is no datasette on PATH\./);
    assert.match(text(notices), /pip install datasette\), then run \/lens datasette again\./);
    assert.deepEqual([r.spawned, r.opened], [[], []]);
});

test("when something else has the port, /lens grafana says so and starts nothing", async (t) => {
    const r = rig(t, { answers: ["busy"] });
    const notices = await r.pi.lens("grafana");
    assert.equal(notices[0]?.level, "warning");
    assert.match(
        text(notices),
        /Port 3300 on 127\.0\.0\.1 is taken by something that is not grafana\. Choose another with "port" under "lens"/,
    );
    assert.deepEqual([r.spawned, r.opened], [[], []]);
});

test("when the program stops at once, /lens grafana says so with its exit code, and does not wait", async (t) => {
    const r = rig(t, { answers: ["stopped"], exit: { code: 1 } });
    const notices = await r.pi.lens("grafana");
    assert.equal(notices[0]?.level, "warning");
    assert.match(
        text(notices),
        new RegExp(`Grafana stopped as soon as it started \\(exit code 1\\)\\. Its output is in ${r.where.log}\\.`),
    );
    assert.equal(r.opened.length, 0);
    assert.equal(r.slept.length, 0);
});

test("when the viewer never answers, /lens grafana gives up after about a minute and points to the log", async (t) => {
    const r = rig(t, { answers: ["stopped"] });
    const notices = await r.pi.lens("grafana");
    assert.equal(notices[0]?.level, "warning");
    assert.match(
        text(notices),
        new RegExp(
            `Grafana was started but does not answer on http://127\\.0\\.0\\.1:3300 yet\\. ` +
                `Its output is in ${r.where.log}\\.`,
        ),
    );
    assert.equal(r.slept.length, START_ATTEMPTS);
    assert.equal(START_ATTEMPTS * START_WAIT_MS, 60_000);
    assert.equal(r.opened.length, 0);
});

test("a program that cannot be started is reported with the reason", async (t) => {
    const r = rig(t, { answers: ["stopped"], spawnFails: new Error("spawn /usr/bin/grafana EACCES") });
    const notices = await r.pi.lens("grafana");
    assert.equal(notices[0]?.level, "warning");
    assert.match(text(notices), /Could not start \/usr\/bin\/grafana: spawn \/usr\/bin\/grafana EACCES/);
    assert.equal(r.opened.length, 0);
});

test("/lens grafana goes on to the viewer when the import fails, and says the import failed", async (t) => {
    const r = rig(t, { answers: ["running"] });
    mkdirSync(r.where.lens, { recursive: true });
    writeFileSync(
        r.where.index,
        "this is not a database, and it is long enough that SQLite reads a header from it".repeat(10),
    );
    const notices = await r.pi.lens("grafana");
    assert.match(
        notices[0]?.text.split("\n")[0] ?? "",
        /^The import failed: .*\. \/lens rebuild makes the index again\.$/,
    );
    assert.equal(r.opened.length, 1);
});

test("/lens grafana tells how many lines were skipped, and how many rows were too old", async (t) => {
    const r = rig(t, { answers: ["running"] });
    appendLines(r.state, "2026-10-30", ["garbage"]);
    const first = (await r.pi.lens("grafana"))[0]?.text.split("\n")[0];
    assert.equal(first, "The index is up to date. Skipped 1 line that is not a record.");
    appendLines(r.state, "2026-10-30", ["garbage", "more"]);
    assert.equal(
        (await r.pi.lens("grafana"))[0]?.text.split("\n")[0],
        "The index is up to date. Skipped 2 lines that are not records.",
    );
});

// ---- /lens rebuild --------------------------------------------------------------------------------------------------

test("/lens rebuild deletes the index and imports every record file again", async (t) => {
    const r = rig(t);
    writeSample(r.state);
    await r.pi.fire("agent_end");
    // Something in the index that is not in the records: a rebuild must not keep it.
    const db = openIndex(r.where.index);
    db.exec("INSERT INTO imported (file, bytes, skipped, at) VALUES ('1999-01-01.jsonl', 5, 0, 1)");
    db.close();
    const notices = await r.pi.lens("rebuild");
    assert.deepEqual(notices, [
        { level: "info", text: "Rebuilt the index from 4 record files: 14 calls and 6 turns." },
    ]);
    const db2 = openIndex(r.where.index);
    t.after(() => db2.close());
    assert.equal(db2.prepare("SELECT count(*) AS n FROM imported WHERE file = '1999-01-01.jsonl'").get()?.n, 0);
    assert.deepEqual([r.spawned, r.opened, r.probes], [[], [], []], "a rebuild does not touch the viewer");
});

test("/lens rebuild makes a new index when the old one cannot be read", async (t) => {
    const r = rig(t, { answers: ["running"] });
    writeSample(r.state);
    mkdirSync(r.where.lens, { recursive: true });
    writeFileSync(
        r.where.index,
        "this is not a database, and it is long enough that SQLite reads a header from it".repeat(10),
    );
    writeFileSync(`${r.where.index}-wal`, "stale");
    const notices = await r.pi.lens("rebuild");
    assert.deepEqual(notices, [
        { level: "info", text: "Rebuilt the index from 4 record files: 14 calls and 6 turns." },
    ]);
    assert.equal(readStatus(r.where.index)?.calls, 14);
    const status = (await r.pi.lens("status"))[0]?.text.split("\n") ?? [];
    assert.match(status[1] ?? "", INDEX_LINE);
    assert.equal(status.length, 4, "and the failure that was told before is not repeated");
});

test("/lens rebuild with no index yet makes one, and counts the lines it skipped", async (t) => {
    const r = rig(t);
    appendLines(r.state, "2026-10-30", ["garbage"]);
    const notices = await r.pi.lens("rebuild");
    assert.deepEqual(notices, [
        {
            level: "info",
            text: "Rebuilt the index from 1 record file: 0 calls and 0 turns. Skipped 1 line that is not a record.",
        },
    ]);
});

// ---- the command itself ---------------------------------------------------------------------------------------------

test("an unknown word shows the usage, and does nothing else", async (t) => {
    const r = rig(t);
    const notices = await r.pi.lens("restart");
    assert.deepEqual(notices, [
        {
            level: "warning",
            text: "Usage: /lens [ticket KEY | session [id] | days N | compare [days N] | usage | grafana | datasette | rebuild | status]",
        },
    ]);
    assert.deepEqual([r.spawned, r.opened, r.probes], [[], [], []]);
});

test("spaces around the word do not matter", async (t) => {
    const r = rig(t, { answers: ["running"] });
    assert.match((await r.pi.lens("  status  "))[0]?.text ?? "", /^Viewer: /);
});

test("with no screen the viewer commands still do their work, and say nothing", async (t) => {
    const r = rig(t, { mode: "print" });
    writeSample(r.state);
    await r.pi.lens("grafana");
    assert.equal(r.spawned.length, 1);
    assert.equal(r.opened.length, 1);
    assert.deepEqual(r.pi.notices, []);
});

test("the command is /lens, with completions for its words", (t) => {
    const r = rig(t);
    const command = r.pi.commands.get("lens");
    assert.ok(command?.description);
    const words = (prefix: string) =>
        (command.getArgumentCompletions?.(prefix) as Array<{ value: string }> | null)?.map((item) => item.value);
    assert.deepEqual(words(""), [
        "ticket",
        "session",
        "days",
        "compare",
        "usage",
        "grafana",
        "datasette",
        "rebuild",
        "status",
    ]);
    assert.deepEqual(words("u"), ["usage"]);
    assert.deepEqual(words("r"), ["rebuild"]);
    assert.deepEqual(words("st"), ["status"]);
    assert.deepEqual(words("d"), ["days", "datasette"]);
    assert.equal(command.getArgumentCompletions?.("x"), null);
});

test("the import is hooked to the end of an agent run, and to nothing else", (t) => {
    const r = rig(t);
    assert.deepEqual([...r.pi.handlers.keys()], ["agent_end"]);
});

// ---- the lens section of jig.json -----------------------------------------------------------------------------------

test("the factory registers the lens section with its check, even when jig-core loads later", (t) => {
    const pi = new FakePi();
    lens()(pi.api);
    const jig = useJig(t);
    const check = jig.checks.get("lens");
    assert.ok(check, "registered once jig-core is published");
    assert.deepEqual(check({ port: 0 }), ["lens.port: must be a whole number from 1 to 65535"]);
    assert.deepEqual(check({}), []);
});

test("the factory registers the section at once when jig-core is already loaded", (t) => {
    const jig = useJig(t);
    lens()(new FakePi().api);
    assert.ok(jig.checks.has("lens"));
});

test("the port comes from the lens section of jig.json", async (t) => {
    useJig(t, { lens: { port: 4100 } });
    const r = rig(t, { answers: ["running"] });
    const first = (await r.pi.lens("status"))[0]?.text.split("\n")[0];
    assert.equal(first, "Viewer: grafana at http://127.0.0.1:4100, running");
});

test("without a lens section, or without jig-core, the defaults apply", async (t) => {
    const r = rig(t, { answers: ["running"] });
    assert.equal(
        (await r.pi.lens("status"))[0]?.text.split("\n")[0],
        "Viewer: grafana at http://127.0.0.1:3300, running",
        "no jig-core",
    );
    useJig(t, {});
    const again = rig(t, { answers: ["running"] });
    assert.equal(
        (await again.pi.lens("status"))[0]?.text.split("\n")[0],
        "Viewer: grafana at http://127.0.0.1:3300, running",
        "no section",
    );
});

test("the section is read when a command runs, so a change at the next session start is seen", async (t) => {
    const sections: Record<string, unknown> = { lens: { port: 4100 } };
    const jig = useJig(t, sections);
    const r = rig(t, { answers: ["running"] });
    await r.pi.lens("status");
    sections.lens = { port: 4200 };
    const second = (await r.pi.lens("status"))[0]?.text.split("\n")[0];
    assert.equal(second, "Viewer: grafana at http://127.0.0.1:4200, running");
    assert.ok(jig.reads.length >= 2 && jig.reads.every((name) => name === "lens"));
});
