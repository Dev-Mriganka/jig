// Agent files: the front matter is strict, a bad file is skipped and named, a role that does not write cannot list a tool that does,
// and the files are read from the plugin, the configured folders and the user's agent folder, never from the project.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { loadRoles, parseRole, RoleError, roleFolders, shippedFolder, WRITING_TOOLS } from "../src/roles.ts";

const file = (lines: string[], body = "You do the work."): string => `---\n${lines.join("\n")}\n---\n${body}\n`;
const parse = (lines: string[], body?: string, name = "x") => parseRole(file(lines, body), `/roles/${name}.md`, name);

describe("parseRole", () => {
    test("reads the four fields and the prompt", () => {
        const role = parse(
            [
                "name: scout",
                "description: Read-only exploration, with evidence",
                "tools: read, grep, find",
                "writes: false",
            ],
            "You explore.\n\nSecond paragraph.",
        );
        assert.deepEqual(role, {
            name: "scout",
            description: "Read-only exploration, with evidence",
            tools: ["read", "grep", "find"],
            writes: false,
            prompt: "You explore.\n\nSecond paragraph.",
            file: "/roles/x.md",
        });
    });

    test("the name defaults to the file name, tools can be a bracketed list or quoted, and a role that writes needs no tools list", () => {
        const role = parse(["description: d", "writes: true"], undefined, "builder");
        assert.equal(role.name, "builder");
        assert.equal(role.tools, undefined);
        assert.deepEqual(parse(["description: d", "tools: [\"read\", 'grep']"], undefined, "r").tools, [
            "read",
            "grep",
        ]);
        assert.deepEqual(parse(["description: d", "tools: read, read, grep"], undefined, "r").tools, ["read", "grep"]);
    });

    test("comments and blank lines in the front matter are fine; CRLF files are fine", () => {
        const role = parseRole(
            "---\r\n# a comment\r\n\r\ndescription: d\r\ntools: read\r\n---\r\nbody\r\n",
            "/r.md",
            "r",
        );
        assert.equal(role.prompt, "body");
    });

    test("unknown fields are errors, and model, thinking, limits and extensions say where they belong", () => {
        assert.throws(() => parse(["description: d", "tools: read", "colour: red"]), /colour: unknown field/);
        assert.throws(
            () => parse(["description: d", "tools: read", "model: provider/x"]),
            /model: the model comes from configuration/,
        );
        assert.throws(
            () => parse(["description: d", "tools: read", "thinking: high"]),
            /thinking level is part of the model setting/,
        );
        assert.throws(() => parse(["description: d", "tools: read", "maxTurns: 3"]), /limits come from configuration/);
        assert.throws(() => parse(["description: d", "tools: read", "limits: x"]), /limits come from configuration/);
        assert.throws(
            () => parse(["description: d", "tools: read", "extensions: false"]),
            /always loads the same plugins/,
        );
    });

    test("a role that does not write is refused when its tools can: bash, write, edit, or no list at all", () => {
        for (const tool of WRITING_TOOLS) {
            assert.throws(
                () => parse(["description: d", `tools: read, ${tool}`, "writes: false"]),
                new RegExp(`must not list ${tool}`),
            );
        }
        assert.throws(() => parse(["description: d"]), /needs a tools list/);
        assert.doesNotThrow(() => parse(["description: d", "tools: read, bash, write, edit", "writes: true"]));
    });

    test("the other mistakes name their field", () => {
        assert.throws(
            () => parse(["description: d", "tools: read", "name: bad name"]),
            /name: "bad name" must be letters/,
        );
        assert.throws(() => parse(["tools: read"]), /description: needed/);
        assert.throws(() => parse(["description: d", "tools: read", "writes: yes"]), /writes: must be true or false/);
        assert.throws(() => parse(["description: d", "tools: re ad"]), /tools: "re ad" is not a tool name/);
        assert.throws(() => parse(["description: d", "tools: -read"]), /is not a tool name/);
        assert.throws(() => parse(["description: d", "tools: --extension"]), /is not a tool name/);
        assert.throws(() => parse(["description: d", "tools: read", "tools: grep"]), /given twice/);
        assert.throws(() => parse(["description: d", "tools: read", "what is this"]), /is not key: value/);
        assert.throws(() => parse(["description: d", "tools: read"], ""), /prompt after the front matter is empty/);
        assert.throws(() => parseRole("no front matter", "/r.md", "r"), RoleError);
        assert.throws(() => parseRole("---\ndescription: d\n", "/r.md", "r"), /no closing/);
    });
});

describe("the roles that ship", () => {
    const { roles, problems } = loadRoles([shippedFolder()]);

    test("are scout, reviewer and worker, all valid, and name no model", () => {
        assert.deepEqual(problems, []);
        assert.deepEqual([...roles.keys()].sort(), ["reviewer", "scout", "worker"]);
        for (const role of roles.values()) {
            assert.ok(role.description.length > 10 && role.description.length <= 200);
            assert.doesNotMatch(role.prompt, /claude|gpt|sonnet|opus|haiku|gemini/i);
        }
    });

    test("scout and reviewer cannot write; worker can, and has the tools for it", () => {
        for (const name of ["scout", "reviewer"]) {
            const role = roles.get(name);
            assert.equal(role?.writes, false);
            assert.ok(!role?.tools?.some((tool) => WRITING_TOOLS.includes(tool)));
        }
        assert.equal(roles.get("worker")?.writes, true);
        assert.deepEqual(roles.get("scout")?.tools, ["read", "grep", "find", "ls", "git", "logs"]);
        assert.ok(roles.get("worker")?.tools?.includes("bash"));
    });
});

describe("loadRoles", () => {
    function folders(t: { after(fn: () => void): void }): {
        root: string;
        make(name: string, files: Record<string, string>): string;
    } {
        const root = mkdtempSync(path.join(tmpdir(), "jig-agents-roles-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        return {
            root,
            make(name, files) {
                const dir = path.join(root, name);
                mkdirSync(dir, { recursive: true });
                for (const [fileName, text] of Object.entries(files)) writeFileSync(path.join(dir, fileName), text);
                return dir;
            },
        };
    }

    test("a later folder replaces an earlier role of the same name, and adds its own", (t) => {
        const f = folders(t);
        const low = f.make("low", {
            "a.md": file(["description: from low", "tools: read"]),
            "b.md": file(["description: only low", "tools: read"]),
        });
        const high = f.make("high", {
            "a.md": file(["description: from high", "tools: read"]),
            "c.md": file(["description: only high", "tools: read"]),
        });
        const { roles } = loadRoles([low, high]);
        assert.equal(roles.get("a")?.description, "from high");
        assert.deepEqual([...roles.keys()].sort(), ["a", "b", "c"]);
    });

    test("a bad file is skipped and named with the field, and the good ones still load", (t) => {
        const f = folders(t);
        const dir = f.make("r", {
            "good.md": file(["description: ok", "tools: read"]),
            "bad.md": file(["description: ok", "tools: read, bash", "writes: false"]),
            "notes.txt": "not a role",
            ".hidden.md": file(["description: ok", "tools: read"]),
        });
        const { roles, problems } = loadRoles([dir]);
        assert.deepEqual([...roles.keys()], ["good"]);
        assert.equal(problems.length, 1);
        assert.equal(path.basename(problems[0]?.file ?? ""), "bad.md");
        assert.match(problems[0]?.problem ?? "", /must not list bash/);
    });

    test("a folder that does not exist gives nothing, and a huge file is refused", (t) => {
        const f = folders(t);
        const dir = f.make("r", { "big.md": file(["description: d", "tools: read"], "x".repeat(40_000)) });
        const { roles, problems } = loadRoles(["/nonexistent/folder", dir]);
        assert.equal(roles.size, 0);
        assert.match(problems[0]?.problem ?? "", /larger than 32 KiB/);
    });

    test("the folders are the plugin's, the configured ones, then the user's agent folder, and never the project's", () => {
        const folders = roleFolders(["/company/roles"], "/home/me/.pi/agent", "/plugin/agents");
        assert.deepEqual(folders, ["/plugin/agents", "/company/roles", "/home/me/.pi/agent/agents"]);
        assert.ok(!folders.some((folder) => folder.includes(".pi/agents") && !folder.includes("/agent/")));
    });
});
