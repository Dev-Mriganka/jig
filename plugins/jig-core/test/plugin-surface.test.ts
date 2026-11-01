// What every plugin gives the agent and the user, pinned: its tools and their actions (what the model is told it can call), its slash
// commands, and the `jig.json` sections it registers (what a person's configuration and a company plugin's defaults are written in).
// The expectations are LITERALS written in this file. A tool, an action, a command or a section that is renamed or removed breaks the
// agent's habits, people's files and company plugins, so it fails here until a person changes the literal on purpose
// (docs/compatibility.md: removing needs a docs/decisions.md entry first; adding is fine, add it here).
//
// Each plugin's extension is loaded, as Pi loads it, into a stand-in for Pi with jig-core in front. Nothing starts: a factory only registers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { jig, withdrawJig } from "../src/client.ts";
import { jigCore } from "../src/index.ts";
import { fakePi } from "./support/fake-pi.ts";
import { tempState } from "./support/state.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const state = tempState();
beforeEach(() => state.start());
afterEach(() => state.stop());

interface Given {
    /** Tool name to the names of its `action` parameter, sorted; no actions is an empty list. */
    tools: Record<string, string[]>;
    commands: string[];
    sections: string[];
}

const EXPECTED: Record<string, Given> = {
    "jig-core": { tools: { watch: ["list", "stop"] }, commands: ["jig"], sections: [] },
    "jig-sandbox": {
        tools: { bash: [], bg_kill: [], bg_list: [], bg_output: [] },
        commands: ["ps", "sandbox"],
        sections: ["sandbox"],
    },
    "jig-memory": { tools: {}, commands: ["ticket"], sections: ["memory"] },
    "jig-workflow": {
        tools: { workflow: ["advance", "back", "bind", "list", "scenario", "start", "status", "submit-plan", "test"] },
        commands: ["workflow"],
        sections: ["workflow"],
    },
    "jig-agents": {
        tools: { subagent: ["message", "start", "status", "stop"] },
        commands: ["agents"],
        sections: ["agents"],
    },
    "jig-git": {
        tools: {
            git: [
                "blame",
                "branch",
                "branches",
                "cherry_pick",
                "clone",
                "commit",
                "diff",
                "fetch",
                "log",
                "merge",
                "push",
                "rebase",
                "restore",
                "show",
                "stash",
                "status",
                "sync",
                "worktree",
            ],
            pr: [
                "comment",
                "comments",
                "create",
                "edit",
                "list",
                "merge",
                "ready",
                "reply",
                "resolve",
                "review",
                "view",
                "watch",
            ],
            release: ["release_create", "releases", "tag_create", "tag_push", "tags"],
        },
        commands: [],
        sections: ["git"],
    },
    "jig-lens": { tools: {}, commands: ["lens"], sections: ["lens"] },
    "jig-jira": {
        tools: {
            jira: [
                "assignable",
                "attachments",
                "changelog",
                "comment",
                "comments",
                "create",
                "delete_comment",
                "edit_comment",
                "find_field",
                "get",
                "link",
                "link_types",
                "search",
                "transition",
                "transitions",
                "unlink",
                "update",
            ],
        },
        commands: [],
        sections: ["jira"],
    },
    "jig-logs": { tools: { logs: [] }, commands: [], sections: ["logs"] },
    "jig-api": {
        tools: { api: ["call", "list", "run", "run-folder", "show"] },
        commands: ["api"],
        sections: ["api"],
    },
    "jig-ops": {
        tools: {
            ci: ["log", "rerun", "run", "runs", "status", "trigger", "watch"],
            deploy: ["plan", "rollback", "run", "status", "watch"],
            runtime: ["events", "health", "logs", "pods", "rollout"],
        },
        commands: [],
        sections: ["ops"],
    },
    "jig-review": {
        tools: { record_interactive_review_resolution: [], start_interactive_code_review: [] },
        commands: ["code-review"],
        sections: [],
    },
    "jig-mongo": {
        tools: {
            mongo: [
                "aggregate",
                "bulk",
                "collections",
                "count",
                "create-index",
                "databases",
                "delete",
                "distinct",
                "drop-index",
                "explain",
                "find",
                "index-stats",
                "indexes",
                "insert",
                "replace",
                "sample",
                "schema",
                "stats",
                "update",
            ],
        },
        commands: [],
        sections: ["mongo"],
    },
    "jig-theme": { tools: {}, commands: ["theme"], sections: ["theme"] },
};

/** The plugins in the order package.json loads them: jig-core first, then each other plugin's `src/index.ts`. */
function extensions(): Array<{ plugin: string; file: string }> {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
        pi: { extensions: string[] };
    };
    return manifest.pi.extensions.map((entry) => ({
        plugin: /^\.\/plugins\/([^/]+)\//.exec(entry)?.[1] ?? entry,
        file: path.join(ROOT, entry),
    }));
}

test("every plugin registers exactly these tools with these actions, these commands and these jig.json sections", async () => {
    const host = fakePi();
    const seen: Record<string, Given> = {};
    let current = "";
    let sections: string[] = [];
    const record = async (plugin: string, factory: ExtensionFactory): Promise<void> => {
        current = plugin;
        sections = [];
        const tools = new Set(host.registered.keys());
        const commands = new Set(host.commands.keys());
        await factory(host.pi);
        const given: Given = { tools: {}, commands: [], sections };
        for (const [name, tool] of host.registered) {
            if (tools.has(name)) continue;
            const action = (tool.parameters as { properties?: Record<string, { enum?: string[] }> }).properties?.action;
            given.tools[name] = [...(action?.enum ?? [])].sort();
        }
        given.commands = [...host.commands.keys()].filter((name) => !commands.has(name)).sort();
        given.sections = [...sections].sort();
        seen[plugin] = given;
    };

    const [first, ...rest] = extensions();
    assert.equal(first?.plugin, "jig-core");
    await record("jig-core", jigCore());
    const api = jig();
    const register = api.config.registerSection.bind(api.config);
    (api.config as { registerSection: typeof register }).registerSection = (name, validate, options) => {
        if (current !== "") sections.push(name);
        register(name, validate, options);
    };
    for (const { plugin, file } of rest) {
        const module = (await import(file)) as { default: ExtensionFactory };
        await record(plugin, module.default);
    }

    const declared = new Map(api.tools?.declared().map((entry) => [entry.tool, entry.plugin]));
    withdrawJig(api);
    assert.deepEqual(seen, EXPECTED);
    // A tool is declared to jig-core by the plugin that registers it, so the record names the right plugin.
    for (const [plugin, given] of Object.entries(seen)) {
        for (const tool of Object.keys(given.tools))
            assert.equal(declared.get(tool), plugin, `${tool} is declared by ${plugin}`);
    }
});
