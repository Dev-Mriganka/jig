// The files a viewer reads: the Grafana dashboards, the provisioning files and Datasette's metadata. Every query in
// them is run against a real index built from sample records, so a panel that names a table or a column that does not
// exist fails here, and not in somebody's browser.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { importRecords } from "../src/import.ts";
import { lensPaths, ownViewerDir } from "../src/paths.ts";
import { openIndex } from "../src/store.ts";
import { DASHBOARDS_VARIABLE, DATASETTE_DATABASE, HOME_DASHBOARD, INDEX_VARIABLE } from "../src/viewer.ts";
import { appendLines, call, NOW, paths, sampleIndex, writeSample } from "./support.ts";

const VIEWER = ownViewerDir();
const DASHBOARDS = path.join(VIEWER, "grafana", "dashboards");
const DATASOURCE = { type: "frser-sqlite-datasource", uid: "jig-lens" };

interface Target {
    refId: string;
    datasource: unknown;
    queryType: string;
    rawQueryText: string;
    queryText: string;
    timeColumns: string[];
}

interface Panel {
    id: number;
    type: string;
    title: string;
    datasource: unknown;
    targets: Target[];
    gridPos: { h: number; w: number; x: number; y: number };
    fieldConfig: {
        overrides: Array<{
            matcher: { id: string; options: string };
            properties: Array<{ id: string; value: unknown }>;
        }>;
    };
}

interface Variable {
    name: string;
    type: string;
    datasource: unknown;
    query: string;
    definition: string;
}

interface Dashboard {
    uid: string;
    title: string;
    tags: string[];
    timezone: string;
    time: { from: string; to: string };
    links: Array<{ type: string; tags: string[] }>;
    templating: { list: Variable[] };
    panels: Panel[];
}

const dashboards = new Map<string, Dashboard>(
    readdirSync(DASHBOARDS)
        .sort()
        .map((name) => [name, JSON.parse(readFileSync(path.join(DASHBOARDS, name), "utf8")) as Dashboard]),
);

/** The range the sample records fall in, in milliseconds as Grafana gives it. */
const FROM = Date.parse("2026-10-26T00:00:00Z");
const TO = Date.parse("2026-10-31T00:00:00Z");

/** What Grafana puts in a query before it reaches SQLite, for the variables these dashboards use. */
function interpolate(sql: string, range = { from: FROM, to: TO }, session = "s1"): string {
    const text = sql
        .replaceAll("$__from", String(range.from))
        .replaceAll("$__to", String(range.to))
        .replaceAll("${session:singlequote}", `'${session}'`);
    // A variable that is not one of those is a mistake: Grafana would send it to SQLite as it is. A JSON path (`$.x`)
    // is not a variable.
    assert.doesNotMatch(text, /\$[{A-Za-z_]/, `an unknown variable in: ${sql}`);
    return text;
}

let state = "";
let db: DatabaseSync;

before(async () => {
    state = mkdtempSync(path.join(os.tmpdir(), "jig-lens-files-"));
    const where = await sampleIndex(state);
    // Read only, as Grafana opens it: a panel that wrote would fail.
    db = new DatabaseSync(where.index, { readOnly: true });
});

after(() => {
    db.close();
    rmSync(state, { recursive: true, force: true });
});

function run(sql: string, parameters: Record<string, SQLInputValue> = {}, from: DatabaseSync = db) {
    const statement = from.prepare(sql);
    return {
        columns: statement.columns().map((column) => column.name),
        rows: statement.all(parameters).map((row) => ({ ...row })),
    };
}

const everyTarget = () =>
    [...dashboards].flatMap(([file, dashboard]) =>
        dashboard.panels.flatMap((panel) => panel.targets.map((target) => ({ file, dashboard, panel, target }))),
    );

describe("the dashboards", () => {
    test("there is one JSON file for each of the five dashboards", () => {
        assert.deepEqual(
            [...dashboards.keys()],
            ["checks.json", "overview.json", "session.json", "tools.json", "your-time.json"],
        );
        assert.deepEqual(
            [...dashboards.values()].map((dashboard) => dashboard.title),
            ["Jig: checks", "Jig: overview", "Jig: session", "Jig: tools", "Jig: your time"],
        );
    });

    test("each has its own uid, the tag that lists the Jig dashboards together, and UTC days", () => {
        const uids = [...dashboards.values()].map((dashboard) => dashboard.uid);
        assert.equal(new Set(uids).size, 5);
        for (const dashboard of dashboards.values()) {
            assert.match(dashboard.uid, /^jig-[a-z]+$/);
            assert.deepEqual(dashboard.tags, ["jig"]);
            assert.equal(dashboard.timezone, "utc", "days are UTC days, like the record files");
            assert.ok(
                dashboard.links.some((link) => link.type === "dashboards" && link.tags.includes("jig")),
                "links to the others",
            );
        }
    });

    test("the dashboard that /lens opens is one of them", () => {
        assert.ok([...dashboards.values()].some((dashboard) => dashboard.uid === HOME_DASHBOARD));
        assert.equal(HOME_DASHBOARD, "jig-overview");
    });

    test("every panel and every query uses the one data source, and panel ids and places do not clash", () => {
        for (const [file, dashboard] of dashboards) {
            assert.ok(dashboard.panels.length >= 4, file);
            assert.equal(
                new Set(dashboard.panels.map((panel) => panel.id)).size,
                dashboard.panels.length,
                `${file}: ids`,
            );
            const taken = new Set<string>();
            for (const panel of dashboard.panels) {
                assert.deepEqual(panel.datasource, DATASOURCE, `${file}: ${panel.title}`);
                assert.ok(panel.title, `${file}: a title`);
                const { x, y, w, h } = panel.gridPos;
                assert.ok(x >= 0 && w > 0 && x + w <= 24, `${file}: ${panel.title} fits the 24 columns`);
                for (let row = y; row < y + h; row++) {
                    for (let column = x; column < x + w; column++) {
                        assert.equal(
                            taken.has(`${column},${row}`),
                            false,
                            `${file}: ${panel.title} overlaps another panel`,
                        );
                        taken.add(`${column},${row}`);
                    }
                }
                for (const target of panel.targets) {
                    assert.deepEqual(target.datasource, DATASOURCE, `${file}: ${panel.title}`);
                    assert.ok(["table", "time series"].includes(target.queryType), `${file}: ${panel.title}`);
                }
            }
            for (const variable of dashboard.templating.list)
                assert.deepEqual(variable.datasource, DATASOURCE, `${file}: ${variable.name}`);
        }
    });

    test("every query runs against a real index, and its time columns are columns it returns", () => {
        let ran = 0;
        for (const { file, panel, target } of everyTarget()) {
            const where = `${file}: ${panel.title}`;
            assert.equal(target.queryText, target.rawQueryText, `${where}: Grafana fills queryText from rawQueryText`);
            assert.match(target.rawQueryText, /^\s*(SELECT|WITH)\b/i, `${where}: a panel only reads`);
            const { columns } = run(interpolate(target.rawQueryText));
            for (const name of target.timeColumns)
                assert.ok(columns.includes(name), `${where}: time column ${name} in ${columns.join(", ")}`);
            if (target.queryType === "time series") {
                assert.deepEqual(target.timeColumns, ["day"], `${where}: a time series says which column is its time`);
                assert.equal(columns[0], "day", `${where}: and returns it first`);
            }
            ran++;
        }
        assert.ok(ran >= 30, `only ${ran} queries were found`);
    });

    test("every panel shows something for the sample records", () => {
        for (const { file, panel, target } of everyTarget()) {
            const { rows } = run(interpolate(target.rawQueryText));
            assert.ok(rows.length > 0, `${file}: ${panel.title} returned no rows`);
        }
    });

    test("a time range with no records shows nothing: every query that filters by time does", () => {
        const nothing = { from: Date.parse("2020-01-01T00:00:00Z"), to: Date.parse("2020-01-02T00:00:00Z") };
        let filtered = 0;
        for (const { file, panel, target } of everyTarget()) {
            if (!target.rawQueryText.includes("$__from")) continue;
            filtered++;
            const { rows } = run(interpolate(target.rawQueryText, nothing));
            // A statistic is one row, and says zero.
            const empty =
                rows.length === 0 ||
                (panel.type === "stat" && Object.values(rows[0] ?? {}).every((value) => value === 0 || value === null));
            assert.ok(empty, `${file}: ${panel.title} ignores the time range: ${JSON.stringify(rows.slice(0, 2))}`);
        }
        assert.ok(filtered >= 25);
    });

    test("a narrower time range shows fewer calls", () => {
        const calls = (from: string) => {
            const stat = dashboards.get("overview.json")?.panels.find((panel) => panel.title === "Tool calls");
            const query = interpolate(stat?.targets[0]?.rawQueryText ?? "", { from: Date.parse(from), to: TO });
            return Number(run(query).rows[0]?.calls);
        };
        assert.equal(calls("2026-10-26T00:00:00Z"), 14);
        assert.equal(calls("2026-10-29T00:00:00Z"), 6);
        assert.equal(calls("2026-10-30T00:00:00Z"), 3);
    });

    test("the cost per day adds up to the cost of the turns, and the calls per day to the calls", () => {
        const overview = dashboards.get("overview.json");
        const query = (title: string) =>
            interpolate(overview?.panels.find((panel) => panel.title === title)?.targets[0]?.rawQueryText ?? "");
        const cost = run(query("Cost per day")).rows.reduce((sum, row) => sum + Number(row.cost), 0);
        assert.ok(Math.abs(cost - 0.46) < 1e-9, String(cost));
        const calls = run(query("Calls and errors per day")).rows.reduce(
            (sum, row) => sum + Number(row.ok) + Number(row.errors) + Number(row.blocked),
            0,
        );
        assert.equal(calls, 14, "every call ended as ok, error or blocked");
    });

    test("the cache hit rate is the share of prompt tokens read from the cache", () => {
        const panel = dashboards.get("overview.json")?.panels.find((candidate) => candidate.title === "Cost per model");
        const rows = run(interpolate(panel?.targets[0]?.rawQueryText ?? "")).rows;
        const modelA = rows.find((row) => row.model === "model-a");
        // model-a: input 4 x 1000, cache read 4000 + 6000 + 9000 + 12000, cache write 500.
        assert.equal(modelA?.["cache hit %"], 87.3);
        assert.equal(rows.find((row) => row.model === "model-b")?.["cache hit %"], 0);
    });
});

describe("the session dashboard", () => {
    const session = () => {
        const dashboard = dashboards.get("session.json");
        assert.ok(dashboard);
        return dashboard;
    };

    test("has a variable named session, listing every session newest first, with the id as its value", () => {
        const [variable, ...others] = session().templating.list;
        assert.equal(others.length, 0);
        assert.equal(variable?.name, "session");
        assert.equal(variable?.type, "query");
        assert.equal(variable?.query, variable?.definition);
        const { columns, rows } = run(variable?.query ?? "");
        assert.deepEqual(columns, ["__text", "__value"]);
        assert.deepEqual(
            rows.map((row) => row.__value),
            ["s1", "s2", "s3"],
            "newest first, and all of them",
        );
        assert.equal(rows[0]?.__text, "2026-10-30 09:03  main  s1");
        assert.equal(rows[2]?.__text, "2026-10-29 08:02  reviewer  s3");
    });

    test("its variable query does not depend on the time range, so a link to an old session still finds it", () => {
        const query = session().templating.list[0]?.query ?? "";
        assert.doesNotMatch(query, /\$__/);
    });

    test("shows every call and turn of the chosen session in order, and only that session's", () => {
        const panel = session().panels.find((candidate) => candidate.title === "Every call and turn, in order");
        const sql = panel?.targets[0]?.rawQueryText ?? "";
        const rows = (id: string) => run(interpolate(sql, { from: FROM, to: TO }, id)).rows;
        const s1 = rows("s1");
        assert.equal(s1.length, 11, "8 calls and 3 turns");
        assert.deepEqual(
            s1.map((row) => row.kind),
            ["turn", "call", "call", "call", "call", "turn", "turn", "call", "call", "call", "call"],
        );
        const times = s1.map((row) => Number(row.time));
        assert.deepEqual(
            times,
            [...times].sort((a, b) => a - b),
        );
        assert.equal(rows("s3").length, 3);
        assert.deepEqual(rows("nobody"), []);
        assert.equal(s1.find((row) => row.what === "http")?.decision, "deny");
        assert.equal(s1.find((row) => row.what === "git push" && row.answer === "allow")?.waited, 3000);
    });

    test("its numbers are those of the chosen session", () => {
        const value = (title: string, id: string) => {
            const panel = session().panels.find((candidate) => candidate.title === title);
            return Object.values(
                run(interpolate(panel?.targets[0]?.rawQueryText ?? "", { from: FROM, to: TO }, id)).rows[0] ?? {},
            )[0];
        };
        assert.equal(value("Cost", "s1"), 0.35);
        assert.equal(value("Model turns", "s1"), 3);
        assert.equal(value("Tool calls", "s1"), 8);
        assert.equal(value("Calls that failed or were refused", "s1"), 2);
        assert.equal(value("Waited for you", "s1"), 3800);
        assert.equal(value("Tool calls", "s3"), 2);
    });

    test("names the parent of a child session", () => {
        const panel = session().panels.find((candidate) => candidate.title === "This session");
        const row = run(interpolate(panel?.targets[0]?.rawQueryText ?? "", { from: FROM, to: TO }, "s3")).rows[0];
        assert.equal(row?.role, "reviewer");
        assert.equal(row?.["parent session"], "s1");
    });
});

describe("the links between dashboards", () => {
    const links = (dashboard: Dashboard) =>
        dashboard.panels.flatMap((panel) =>
            panel.fieldConfig.overrides.flatMap((override) =>
                override.properties
                    .filter((property) => property.id === "links")
                    .flatMap((property) =>
                        (property.value as Array<{ url: string }>).map((link) => ({ panel, override, url: link.url })),
                    ),
            ),
        );

    test("the Overview and Tools tables link a session to the session dashboard, as its variable", () => {
        for (const file of ["overview.json", "tools.json"]) {
            const dashboard = dashboards.get(file);
            assert.ok(dashboard);
            const found = links(dashboard);
            assert.ok(found.length >= 1, `${file} has a link`);
            for (const { panel, override, url } of found) {
                assert.equal(
                    override.matcher.options,
                    "session",
                    `${file}: ${panel.title} links from the session column`,
                );
                assert.equal(url, "/d/jig-session?var-session=${__value.raw}");
                // The column the link is on is a column of the query.
                const { columns } = run(interpolate(panel.targets[0]?.rawQueryText ?? ""));
                assert.ok(columns.includes("session"), `${file}: ${panel.title}`);
            }
        }
    });

    test("every link names a dashboard that exists and a variable that dashboard has", () => {
        const byUid = new Map([...dashboards.values()].map((dashboard) => [dashboard.uid, dashboard]));
        let checked = 0;
        for (const [file, dashboard] of dashboards) {
            for (const { url } of links(dashboard)) {
                const match = /^\/d\/([a-z-]+)\?var-([a-z]+)=/.exec(url);
                assert.ok(match, `${file}: ${url}`);
                const target = byUid.get(match[1] ?? "");
                assert.ok(target, `${file}: no dashboard ${match[1]}`);
                assert.ok(
                    target.templating.list.some((variable) => variable.name === match[2]),
                    `${file}: ${url}`,
                );
                checked++;
            }
        }
        assert.ok(checked >= 6);
    });

    test("a session id from a table is a value the session variable lists", () => {
        const sessions = run(dashboards.get("session.json")?.templating.list[0]?.query ?? "").rows.map(
            (row) => row.__value,
        );
        const overview = dashboards.get("overview.json")?.panels.find((panel) => panel.title === "Sessions, by cost");
        const linked = run(interpolate(overview?.targets[0]?.rawQueryText ?? "")).rows.map((row) => row.session);
        assert.deepEqual([...linked].sort(), [...sessions].sort());
    });
});

describe("the checks dashboard", () => {
    const panel = (title: string) =>
        dashboards.get("checks.json")?.panels.find((candidate) => candidate.title === title);

    test("reads the numbers and codes of the facts with json_extract", () => {
        const rows = run(interpolate(panel("Calls with facts")?.targets[0]?.rawQueryText ?? "")).rows;
        assert.equal(rows.length, 2);
        assert.deepEqual(
            rows.map((row) => [row.tool, row.passed, row.failed, row.conclusion]),
            [
                ["flow", 10, 2, null],
                ["checks", 12, 0, "success"],
            ],
        );
        assert.match(panel("Calls with facts")?.targets[0]?.rawQueryText ?? "", /json_extract\(facts, '\$\.passed'\)/);
    });

    test("sums the test counts per day and counts the conclusions", () => {
        const days = run(interpolate(panel("Tests passed and failed, per day")?.targets[0]?.rawQueryText ?? "")).rows;
        assert.deepEqual(
            days.map((row) => [row.passed, row.failed]),
            [
                [12, 0],
                [10, 2],
            ],
        );
        const conclusions = run(interpolate(panel("CI conclusions")?.targets[0]?.rawQueryText ?? "")).rows;
        assert.deepEqual(conclusions, [{ conclusion: "success", runs: 1 }]);
    });

    test("lists every fact name in use, with the range of its numbers", () => {
        const rows = run(interpolate(panel("Facts the tools report")?.targets[0]?.rawQueryText ?? "")).rows;
        assert.deepEqual(
            rows.map((row) => `${row.tool}.${row.action}.${row.fact}:${row.lowest}-${row.highest}`),
            [
                "checks.watch.conclusion:null-null",
                "checks.watch.failed:0-0",
                "checks.watch.passed:12-12",
                "flow.test.failed:2-2",
                "flow.test.ok:null-null",
                "flow.test.passed:10-10",
            ],
        );
    });
});

describe("the tools and time dashboards", () => {
    const rows = (file: string, title: string) => {
        const found = dashboards.get(file)?.panels.find((candidate) => candidate.title === title);
        return run(interpolate(found?.targets[0]?.rawQueryText ?? "")).rows;
    };

    test("calls refused by a rule are the calls with decision deny", () => {
        const refused = rows("tools.json", "Calls refused by a rule");
        assert.equal(refused.length, 1);
        assert.equal(refused[0]?.tool, "http");
        assert.equal(refused[0]?.["decided by"], "floor");
    });

    test("failures are grouped by error kind, and slow tools by their average time", () => {
        const kinds = rows("tools.json", "Failures per error kind").map((row) => [row.errorKind, row.calls]);
        assert.deepEqual(kinds, [
            ["tool", 2],
            ["declined", 1],
            ["denied", 1],
            ["dismissed", 1],
            ["not-run", 1],
        ]);
        const slowest = rows("tools.json", "Slowest tools");
        assert.deepEqual(
            slowest.slice(0, 2).map((row) => [row.tool, row.average]),
            [
                ["checks", 60000],
                ["flow", 45000],
            ],
        );
        assert.ok(
            slowest.every((row) => row.calls !== null),
            "a call that never ran has no time, so it is not listed",
        );
    });

    test("an error kind that jig-core adds later is grouped like any other", async () => {
        // `invalid`: the tool's preview found the input invalid, so nobody was asked. The index keeps the kind as text,
        // and no query names the kinds, so nothing else needs to change.
        const folder = mkdtempSync(path.join(os.tmpdir(), "jig-lens-kind-"));
        try {
            writeSample(folder);
            const invalid = {
                ...call("c-invalid", "2026-10-30T10:00:00Z", "s2", "jira", { effect: "write" }),
                outcome: "blocked",
                errorKind: "invalid",
                error: "the issue key is not valid",
            };
            appendLines(folder, "2026-10-30", [JSON.stringify(invalid)]);
            const where = paths(folder);
            const writer = openIndex(where.index);
            await importRecords(writer, { records: where.records, now: NOW });
            writer.close();

            const reader = new DatabaseSync(where.index, { readOnly: true });
            try {
                const panel = dashboards.get("tools.json")?.panels.find((p) => p.title === "Failures per error kind");
                const grouped = run(interpolate(panel?.targets[0]?.rawQueryText ?? ""), {}, reader).rows;
                assert.deepEqual(
                    grouped.map((row) => [row.errorKind, row.calls]),
                    [
                        ["tool", 2],
                        ["declined", 1],
                        ["denied", 1],
                        ["dismissed", 1],
                        ["invalid", 1],
                        ["not-run", 1],
                    ],
                );
                const metadata = JSON.parse(readFileSync(path.join(VIEWER, "datasette", "metadata.json"), "utf8")) as {
                    databases: Record<string, { queries: Record<string, { sql: string }> }>;
                };
                const canned = metadata.databases[DATASETTE_DATABASE]?.queries.failures_per_error_kind?.sql ?? "";
                assert.ok(run(canned, {}, reader).rows.some((row) => row.errorKind === "invalid"));
            } finally {
                reader.close();
            }
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    });

    test("questions are the calls that asked, with how they were answered and how long they waited", () => {
        const perTool = rows("your-time.json", "Questions per tool");
        assert.deepEqual(
            perTool.map((row) => [
                row.tool,
                row.questions,
                row.allowed,
                row["allowed for the session"],
                row.declined,
                row.waited,
            ]),
            [
                ["bash", 2, 0, 0, 2, 10500],
                ["git", 2, 1, 1, 0, 3800],
            ],
        );
        const longest = rows("your-time.json", "Longest waits");
        assert.deepEqual(
            longest.map((row) => row.waited),
            [9000, 3000, 1500, 800],
        );
    });
});

describe("the provisioning files", () => {
    const read = (...parts: string[]) => readFileSync(path.join(VIEWER, "grafana", "provisioning", ...parts), "utf8");

    /** The `key: value` lines of a file as simple as these two, with their comments left out. */
    const keys = (text: string) =>
        Object.fromEntries(
            text
                .split("\n")
                .filter((line) => !line.trim().startsWith("#") && line.includes(":"))
                .map((line) => {
                    const at = line.indexOf(":");
                    return [line.slice(0, at).trim().replace(/^- /, ""), line.slice(at + 1).trim()];
                }),
        );

    test("the data source opens only the index, and read only", () => {
        const text = read("datasources", "jig.yaml");
        const data = keys(text);
        assert.equal(data.type, "frser-sqlite-datasource");
        assert.equal(data.uid, DATASOURCE.uid, "the uid the dashboards name");
        assert.equal(data.pathOptions, "mode=ro", "SQLite opens the file read only");
        assert.equal(data.pathPrefix, '"file:"', "a file: address, so the options reach SQLite");
        assert.equal(data.path, `$${INDEX_VARIABLE}`, "the start-up says where the index is");
        assert.equal(data.editable, "false");
        assert.equal(data.isDefault, "true");
        const settings = text
            .split("\n")
            .filter((line) => !line.trim().startsWith("#"))
            .join("\n");
        assert.doesNotMatch(settings, /immutable|mode=rw|mode=rwc|attach/i, "nothing that would open it for writing");
        assert.doesNotMatch(settings, /\/(home|tmp|var|Users)\//, "no path of any machine");
    });

    test("the data source has no password, key or other secret", () => {
        assert.doesNotMatch(read("datasources", "jig.yaml"), /secureJsonData|password|token|apiKey/i);
    });

    test("the dashboards come from the files of this plugin, and are read only in the browser", () => {
        const text = read("dashboards", "jig.yaml");
        const data = keys(text);
        assert.equal(data.type, "file");
        assert.equal(data.path, `$${DASHBOARDS_VARIABLE}`);
        assert.equal(data.allowUiUpdates, "false");
        assert.equal(data.disableDeletion, "true");
        assert.equal(data.folder, "Jig");
        assert.doesNotMatch(text, /\/(home|tmp|var|Users)\//);
    });

    test("the folder Grafana is pointed at holds both, and the dashboards folder holds the dashboards", () => {
        const provisioning = lensPaths(state).provisioning;
        assert.equal(statSync(path.join(provisioning, "datasources", "jig.yaml")).isFile(), true);
        assert.equal(statSync(path.join(provisioning, "dashboards", "jig.yaml")).isFile(), true);
        assert.equal(lensPaths(state).dashboards, DASHBOARDS);
        assert.equal(readdirSync(lensPaths(state).dashboards).filter((name) => name.endsWith(".json")).length, 5);
    });

    test("the folders Grafana looks in for plugins and alerts exist, empty, so that it logs no error for them", () => {
        const provisioning = lensPaths(state).provisioning;
        for (const folder of ["plugins", "alerting"]) {
            assert.equal(statSync(path.join(provisioning, folder)).isDirectory(), true, folder);
            assert.deepEqual(readdirSync(path.join(provisioning, folder)), [".gitkeep"], folder);
        }
    });
});

describe("Datasette's metadata", () => {
    interface Metadata {
        databases: Record<string, { allow_sql?: unknown; queries: Record<string, { title: string; sql: string }> }>;
    }
    const metadata = JSON.parse(readFileSync(path.join(VIEWER, "datasette", "metadata.json"), "utf8")) as Metadata;
    const queries = Object.entries(metadata.databases[DATASETTE_DATABASE]?.queries ?? {});

    test("is filed under the name Datasette gives the index, with arbitrary SQL turned off", () => {
        assert.deepEqual(Object.keys(metadata.databases), [DATASETTE_DATABASE]);
        assert.equal(DATASETTE_DATABASE, path.basename(lensPaths("/state").index, ".sqlite"));
        assert.equal(metadata.databases[DATASETTE_DATABASE]?.allow_sql, false);
    });

    test("holds the canned queries, each with a title", () => {
        assert.ok(queries.length >= 12);
        for (const [name, query] of queries) {
            assert.match(name, /^[a-z_]+$/);
            assert.ok(query.title, name);
        }
    });

    test("every canned query runs against a real index, with the parameter it takes", () => {
        for (const [name, query] of queries) {
            assert.match(query.sql, /^\s*(SELECT|WITH)\b/i, `${name}: a query only reads`);
            assert.doesNotMatch(query.sql, /\$__/, name);
            const named = [...query.sql.matchAll(/:([a-z_]+)/g)].map((match) => match[1] ?? "");
            const parameters = Object.fromEntries([...new Set(named)].map((parameter) => [parameter, "s1"]));
            const { rows } = run(query.sql, parameters);
            assert.ok(rows.length > 0, `${name} returned no rows for the sample`);
        }
    });

    test("the session timeline takes the session as its one parameter", () => {
        const sql = metadata.databases[DATASETTE_DATABASE]?.queries.session_timeline?.sql ?? "";
        assert.deepEqual([...new Set([...sql.matchAll(/:([a-z_]+)/g)].map((match) => match[1]))], ["session"]);
        assert.equal(run(sql, { session: "s1" }).rows.length, 11);
        assert.equal(run(sql, { session: "s3" }).rows.length, 3);
        // The session is a parameter bound by SQLite, so it cannot change the query.
        assert.equal(run(sql, { session: "s1' OR '1'='1" }).rows.length, 0);
    });
});
