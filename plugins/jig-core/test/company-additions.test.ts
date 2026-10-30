// What a company plugin adds beyond environments and rules: defaults for other plugins' sections of jig.json, and
// tunnels that give a tool a network route of its own.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildApi } from "../src/api.ts";
import type { SectionCheck } from "../src/config.ts";
import { layered } from "../src/section-defaults.ts";
import { createState, loadPersonalConfig } from "../src/state.ts";
import { createTunnels } from "../src/tunnels.ts";

/** Wants `{ url: <string>, indexes?: <string[]> }`. */
const logsCheck: SectionCheck = (raw) => {
    if (typeof raw !== "object" || raw === null) return ["logs must be an object"];
    const value = raw as { url?: unknown; indexes?: unknown };
    const problems: string[] = [];
    if (typeof value.url !== "string") problems.push("logs.url must be a string");
    if (value.indexes !== undefined && !Array.isArray(value.indexes)) problems.push("logs.indexes must be a list");
    return problems;
};

describe("company defaults for a plugin's section", () => {
    let dir: string;
    let counter = 0;
    before(() => {
        dir = mkdtempSync(path.join(tmpdir(), "jig-defaults-"));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    function setup(personal: unknown) {
        const file = path.join(dir, `jig-${counter++}.json`);
        writeFileSync(file, JSON.stringify(personal));
        const state = createState({} as ExtensionAPI);
        const api = buildApi(state);
        api.config.registerSection("logs", logsCheck);
        loadPersonalConfig(state, file);
        return { state, api };
    }

    test("apply when you have no section of your own", () => {
        const { api } = setup({});
        api.config.addSectionDefaults("logs", { url: "https://logs.example.com", indexes: ["app-logs-*"] });
        assert.deepEqual(api.config.section("logs"), { url: "https://logs.example.com", indexes: ["app-logs-*"] });
    });

    test("lie under yours: objects merge key by key, and a list of yours replaces theirs", () => {
        const { api } = setup({ logs: { indexes: ["mine-*"], url: "https://mine.example.com" } });
        api.config.addSectionDefaults("logs", { url: "https://logs.example.com", indexes: ["app-logs-*"] });
        assert.deepEqual(api.config.section("logs"), { url: "https://mine.example.com", indexes: ["mine-*"] });
        assert.deepEqual(layered({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [9] }), {
            a: { b: 1, c: 3 },
            d: [9],
        });
    });

    test("that do not fit with your settings are reported once, and your own section is used when it is complete", () => {
        const { state, api } = setup({ logs: { url: "https://mine.example.com" } });
        api.config.addSectionDefaults("logs", { indexes: "not a list" });
        assert.deepEqual(api.config.section("logs"), { url: "https://mine.example.com" });
        api.config.section("logs");
        const reports = state
            .policy()
            .problems.filter((problem) => problem.message.includes('company defaults for "logs"'));
        assert.equal(reports.length, 1);
        assert.match(reports[0]?.message ?? "", /logs\.indexes must be a list/);
        assert.equal(reports[0]?.key, "logs");
    });

    test("are checked together with your section, so you may write only what you change", () => {
        const { api } = setup({ logs: { indexes: ["mine-*"] } });
        api.config.addSectionDefaults("logs", { url: "https://logs.example.com" });
        assert.deepEqual(api.config.section("logs"), { url: "https://logs.example.com", indexes: ["mine-*"] });
    });

    test("cannot be given for jig-core's own fields", () => {
        const { api } = setup({});
        assert.throws(() => api.config.addSectionDefaults("rules", []), /jig-core field/);
        assert.throws(() => api.config.addSectionDefaults("", {}), TypeError);
    });
});

describe("tunnels", () => {
    test("open through the provider registered by name, and close", async () => {
        const tunnels = createTunnels();
        let closed = 0;
        tunnels.register("company", {
            open: async (target) => ({
                port: 40000 + (target.port % 1000),
                close: () => {
                    closed++;
                },
            }),
        });
        const tunnel = await tunnels.open("company", { host: "db.internal.example.com", port: 27017 });
        assert.equal(tunnel.port, 40017);
        await tunnel.close();
        assert.equal(closed, 1);
    });

    test("have a kind: a forward when the provider does not say, and a socks proxy when it does", async () => {
        const tunnels = createTunnels();
        tunnels.register("plain", { open: async () => ({ port: 41001, close: () => {} }) });
        tunnels.register("forward", { open: async () => ({ kind: "forward", port: 41002, close: () => {} }) });
        tunnels.register("proxy", { open: async () => ({ kind: "socks", port: 41003, close: () => {} }) });
        const target = { host: "db.internal.example.com", port: 27017 };
        assert.equal((await tunnels.open("plain", target)).kind, "forward");
        assert.equal((await tunnels.open("forward", target)).kind, "forward");
        const proxy = await tunnels.open("proxy", target);
        assert.deepEqual([proxy.kind, proxy.port], ["socks", 41003]);
    });

    test("a kind that is neither forward nor socks is named, and so is one that is not text", async () => {
        const tunnels = createTunnels();
        for (const kind of ["tcp", "", 7, null, ["socks"]]) {
            tunnels.register("odd", { open: async () => ({ kind, port: 41004, close: () => {} }) as never });
            await assert.rejects(
                tunnels.open("odd", { host: "h", port: 1 }),
                /tunnel provider "odd" returned a tunnel whose kind is not forward or socks/,
                JSON.stringify(kind),
            );
        }
    });

    test("a tunnel closes through its own close, whatever its kind", async () => {
        const tunnels = createTunnels();
        const closed: string[] = [];
        tunnels.register("proxy", {
            open: async () => ({ kind: "socks", port: 41005, close: async () => void closed.push("proxy") }),
        });
        const tunnel = await tunnels.open("proxy", { host: "h", port: 1 });
        await tunnel.close();
        assert.deepEqual(closed, ["proxy"]);
    });

    test("an unknown name lists the registered ones; a bad target or a bad answer is named", async () => {
        const tunnels = createTunnels();
        await assert.rejects(
            tunnels.open("none", { host: "h", port: 1 }),
            /no tunnel provider named "none" \(none is registered\)/,
        );
        tunnels.register("one", { open: async () => ({ port: 0, close: () => {} }) });
        await assert.rejects(tunnels.open("x", { host: "h", port: 1 }), /registered: one/);
        await assert.rejects(tunnels.open("one", { host: "", port: 1 }), /target host and a port/);
        await assert.rejects(tunnels.open("one", { host: "h", port: 70000 }), /target host and a port/);
        await assert.rejects(tunnels.open("one", { host: "h", port: 1 }), /without a valid local port/);
        tunnels.register("one", { open: async () => ({ port: 5000 }) as never });
        await assert.rejects(tunnels.open("one", { host: "h", port: 1 }), /cannot be closed/);
        tunnels.register("one", {
            open: async () => {
                throw new Error("jump host refused");
            },
        });
        await assert.rejects(
            tunnels.open("one", { host: "h", port: 1 }),
            /tunnel provider "one" failed: jump host refused/,
        );
        assert.throws(() => tunnels.register("bad", {} as never), /must have an open function/);
    });
});

describe("secret commands from a company plugin", () => {
    function setup(personal: unknown) {
        const dir = mkdtempSync(path.join(tmpdir(), "jig-commands-"));
        const file = path.join(dir, "jig.json");
        writeFileSync(file, JSON.stringify(personal));
        const state = createState({} as ExtensionAPI);
        const api = buildApi(state);
        loadPersonalConfig(state, file);
        return { state, api, dir };
    }

    test("are added by name, and the user's own command of the same name replaces the company's", () => {
        const { state, api, dir } = setup({ secrets: { backends: ["cmd"], commands: { gh: ["my-gh", "token"] } } });
        try {
            api.config.addSecretCommands({ gh: ["gh", "auth", "token"], corp: ["corp-login", "--print"] });
            assert.deepEqual(state.company.secretCommands, {
                gh: ["gh", "auth", "token"],
                corp: ["corp-login", "--print"],
            });
            const merged = { ...state.company.secretCommands, ...state.personal.config.secrets.commands };
            assert.deepEqual(merged, { gh: ["my-gh", "token"], corp: ["corp-login", "--print"] });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a wrong declaration is a problem named `company`, and the good ones still apply", () => {
        const { state, api, dir } = setup({});
        try {
            api.config.addSecretCommands({ ok: ["a"], "bad name": ["a"], empty: [], text: "run it" } as never);
            assert.deepEqual(Object.keys(state.company.secretCommands), ["ok"]);
            assert.deepEqual(
                state.company.problems.map((problem) => [problem.source, problem.key]),
                [
                    ["company", "secretCommands.bad name"],
                    ["company", "secretCommands.empty"],
                    ["company", "secretCommands.text"],
                ],
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
