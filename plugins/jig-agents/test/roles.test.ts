// Agent files: the front matter is strict, a bad file is skipped and named, a role that does not write cannot list a tool that does,
// and the files are read from the plugin, the configured folders and the user's agent folder, never from the project.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { GIT_ACTIONS } from "../../jig-git/src/git.ts";
import { THINKING_LEVELS } from "../src/config.ts";
import {
    loadRoles,
    parseRole,
    RoleError,
    roleFolders,
    SANDBOXED_TOOLS,
    shippedFolder,
    WRITING_TOOLS,
} from "../src/roles.ts";

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

    test("unknown fields are errors, and model, limits and extensions say where they belong", () => {
        assert.throws(() => parse(["description: d", "tools: read", "colour: red"]), /colour: unknown field/);
        assert.throws(
            () => parse(["description: d", "tools: read", "model: provider/x"]),
            /model: the model comes from configuration/,
        );
        assert.throws(() => parse(["description: d", "tools: read", "maxTurns: 3"]), /limits come from configuration/);
        assert.throws(() => parse(["description: d", "tools: read", "limits: x"]), /limits come from configuration/);
        assert.throws(
            () => parse(["description: d", "tools: read", "extensions: false"]),
            /always loads the same plugins/,
        );
    });

    test("a role that does not write is refused when its tools write with nothing around them: write, edit, a Windows shell, or no list at all", () => {
        assert.deepEqual(WRITING_TOOLS, ["powershell", "write", "edit", "notebook_edit"]);
        for (const tool of WRITING_TOOLS) {
            assert.throws(
                () => parse(["description: d", `tools: read, ${tool}`, "writes: false"]),
                new RegExp(`must not list ${tool}`),
            );
        }
        assert.throws(() => parse(["description: d"]), /needs a tools list/);
        assert.doesNotThrow(() => parse(["description: d", "tools: read, bash, write, edit", "writes: true"]));
    });

    test("a role that does not write may list bash: its child runs it in the sandbox, which the launcher checks", () => {
        assert.deepEqual(SANDBOXED_TOOLS, ["bash"]);
        assert.deepEqual(parse(["description: d", "tools: read, bash", "writes: false"]).tools, ["read", "bash"]);
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
        assert.deepEqual(roles.get("scout")?.tools, ["read", "grep", "find", "ls", "git", "logs", "bash"]);
        assert.deepEqual(roles.get("reviewer")?.tools, ["read", "grep", "find", "ls", "git", "bash"]);
        assert.ok(roles.get("worker")?.tools?.includes("bash"));
    });

    test("scout and reviewer run only the read actions of git, which the git tool's own table says are reads", () => {
        const table = readFileSync(path.resolve(import.meta.dirname, "../../jig-git/README.md"), "utf8");
        const section = table.slice(table.indexOf("## Tool: `git`"), table.indexOf("## Tool: `pr`"));
        const reads = [...section.matchAll(/^\| ((?:`\w+`(?:, )?)+) \| read \|/gm)].flatMap((match) =>
            (match[1] as string).split(", ").map((name) => name.replace(/`/g, "")),
        );
        assert.ok(reads.includes("status") && reads.includes("blame"), `reads: ${reads.join(", ")}`);
        for (const name of ["scout", "reviewer"]) {
            const actions = roles.get(name)?.actions;
            assert.deepEqual(Object.keys(actions ?? {}), ["git"], name);
            assert.deepEqual(actions?.git, ["status", "diff", "log", "show", "blame", "branches"], name);
            for (const action of actions?.git ?? []) {
                assert.ok(reads.includes(action), `${name}: ${action} is a read`);
                assert.ok(Object.hasOwn(GIT_ACTIONS, action), `${name}: git has the action ${action}`);
            }
            // The ones left out are the writes, and fetch, which reads from the remote and changes the repository's remote refs.
            for (const left of ["push", "commit", "restore", "merge", "rebase", "fetch"]) {
                assert.ok(!actions?.git?.includes(left), `${name} must not run git ${left}`);
            }
        }
    });

    test("the worker keeps all of git: a push asks by default, and a worker is not narrowed further here", () => {
        assert.equal(roles.get("worker")?.actions, undefined);
        assert.equal(roles.get("worker")?.ask, undefined);
    });

    test("none of the three sets the reading fields, so they follow the tools", () => {
        for (const role of roles.values()) {
            assert.deepEqual(
                [role.skills, role.preload, role.context, role.thinking],
                [undefined, undefined, undefined, undefined],
            );
        }
    });
});

describe("the fields that narrow, and the fields that choose what the child reads", () => {
    const base = ["description: d", "tools: read, git, jira, bash", "writes: false"];

    test("actions is one line: a tool, then its actions with |, and more tools after commas", () => {
        const role = parse([...base, "actions: git status|log|diff, jira get|search"]);
        assert.deepEqual(role.actions, { git: ["status", "log", "diff"], jira: ["get", "search"] });
        assert.deepEqual(parse([...base, "actions: git status|status|log"]).actions, { git: ["status", "log"] });
        assert.deepEqual(parse([...base, "actions: 'git' 'status'|\"log\""]).actions, { git: ["status", "log"] });
    });

    test("ask names tool actions the same way", () => {
        assert.deepEqual(parse([...base, "ask: git push|merge, jira transition"]).ask, {
            git: ["push", "merge"],
            jira: ["transition"],
        });
    });

    test("a tool in actions or ask must be in tools: a role cannot be narrowed on a tool it cannot call", () => {
        assert.throws(() => parse([...base, "actions: pr view"]), /actions: pr is not in tools/);
        assert.throws(() => parse([...base, "ask: pr merge"]), /ask: pr is not in tools/);
        // A role with no tools list has all the tools, so there is nothing to check against.
        assert.deepEqual(parse(["description: d", "writes: true", "actions: git status"]).actions, { git: ["status"] });
    });

    test("tool and action names are names, a tool is given once, and every tool has actions", () => {
        assert.throws(() => parse([...base, "actions: git"]), /actions: "git" needs actions after the tool/);
        assert.throws(() => parse([...base, "actions: git status|"]), /not an action name/);
        assert.throws(() => parse([...base, "actions: git sta tus"]), /"sta tus" is not an action name/);
        assert.throws(() => parse([...base, "actions: git ../x"]), /is not an action name/);
        assert.throws(() => parse([...base, "actions: git status, git log"]), /git is given twice/);
        assert.throws(() => parse([...base, "actions: -git status"]), /is not a tool name/);
        assert.throws(() => parse([...base, "actions: "]), /list 1 to 40 tools/);
        assert.throws(() => parse([...base, "ask: "]), /list 1 to 40 tools/);
    });

    test("ask cannot name an action that actions does not allow: it would never be reached", () => {
        assert.throws(
            () => parse([...base, "actions: git status|log", "ask: git push"]),
            /ask: git push is not among the actions git may run \(status\|log\)/,
        );
        assert.doesNotThrow(() => parse([...base, "actions: git status|log", "ask: git log"]));
    });

    test("skills is none or a list of skill names; preload is a list that must also be seen", () => {
        assert.equal(parse([...base, "skills: none"]).skills, "none");
        assert.deepEqual(parse([...base, "skills: git, jira"]).skills, ["git", "jira"]);
        assert.deepEqual(parse([...base, "skills: git, jira", "preload: jira"]).preload, ["jira"]);
        assert.throws(() => parse([...base, "skills: Git"]), /skills: "Git" is not a skill name/);
        assert.throws(() => parse([...base, "skills: "]), /skills: list 1 to 30 skill names/);
        assert.throws(() => parse([...base, "preload: git--x"]), /preload: "git--x" is not a skill name/);
        assert.throws(
            () => parse([...base, "skills: none", "preload: git"]),
            /sees no skill, so it cannot preload one/,
        );
        assert.throws(() => parse([...base, "skills: git", "preload: jira"]), /preload: jira must also be in skills/);
        // With no skills line the skills follow the tools, which is known only at start: the launcher checks it then.
        assert.deepEqual(parse([...base, "preload: git"]).preload, ["git"]);
    });

    test("context is project or none; thinking is one of Pi's levels", () => {
        assert.equal(parse([...base, "context: none"]).context, "none");
        assert.equal(parse([...base, "context: project"]).context, "project");
        assert.throws(() => parse([...base, "context: some"]), /context: must be "project" or "none"/);
        for (const level of THINKING_LEVELS) assert.equal(parse([...base, `thinking: ${level}`]).thinking, level);
        assert.throws(() => parse([...base, "thinking: deep"]), /thinking: must be one of off, minimal, low/);
    });

    test("a field that is not there leaves the role without it, so a role is the same as before", () => {
        const role = parse(base);
        for (const field of ["actions", "ask", "skills", "preload", "context", "thinking"]) {
            assert.ok(!(field in role), field);
        }
    });

    test("an unknown field names the ones there are", () => {
        assert.throws(
            () => parse([...base, "memory: project"]),
            /memory: unknown field \(use name, description, tools, actions, ask, writes, skills, preload, context, thinking\)/,
        );
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
            "bad.md": file(["description: ok", "tools: read, write", "writes: false"]),
            "notes.txt": "not a role",
            ".hidden.md": file(["description: ok", "tools: read"]),
        });
        const { roles, problems } = loadRoles([dir]);
        assert.deepEqual([...roles.keys()], ["good"]);
        assert.equal(problems.length, 1);
        assert.equal(path.basename(problems[0]?.file ?? ""), "bad.md");
        assert.match(problems[0]?.problem ?? "", /must not list write/);
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
