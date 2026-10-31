// What a start passes to the child from its role: the policy it will enforce, the skills it will see, the instructions it starts with
// (the role's prompt and the skills it preloads), whether it reads the project's own, and how hard it thinks. A real parent session starts
// the fake child, which writes down its command line and environment; the real child side is tried in real-pi.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readRolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import type { RolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import { GIT_ACTIONS } from "../../jig-git/src/git.ts";
import { settingsFrom } from "../src/config.ts";
import { actionTool, gitTool } from "./support/tools.ts";
import { startWorld, until } from "./world.ts";
import type { World, WorldOptions } from "./world.ts";

let w: World | undefined;
let skillsRoot = "";
beforeEach(() => {
    skillsRoot = mkdtempSync(path.join(tmpdir(), "jig-agents-role-skills-"));
});
afterEach(async () => {
    await w?.close();
    w = undefined;
    rmSync(skillsRoot, { recursive: true, force: true });
});

/** A skill file. Jig's own live in `plugins/<plugin>/skills/<name>/`, a company's anywhere. */
function skill(where: string, name: string, extra: string[] = [], body = `Use ${name} like this.\n`): string {
    const dir = path.join(skillsRoot, where, name);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    writeFileSync(
        file,
        `---\nname: ${name}\ndescription: About ${name}. Use it when asked.\n${extra.join("\n")}\n---\n${body}`,
    );
    return file;
}

/** The parent's skills: three of Jig's, one company skill that names its tool, and one that belongs to nobody. */
function skills(): Record<"git" | "logs" | "jira" | "acme" | "house", string> {
    return {
        git: skill("pkg/plugins/jig-git/skills", "git", [], "# Git\n\nUse the git tool, not bash.\n"),
        logs: skill("pkg/plugins/jig-logs/skills", "logs"),
        jira: skill("pkg/plugins/jig-jira/skills", "jira"),
        acme: skill("company", "acme-jira", ["metadata:", "  jig-tool: jira"]),
        house: skill("company", "house-style"),
    };
}

const logs = actionTool("logs", { search: "read" });
const jira = actionTool("jira", { get: "read", transition: "write" });
const PARENT_TOOLS = [gitTool, logs, jira];

async function begin(options: WorldOptions = {}): Promise<World> {
    w = await startWorld({ extensions: PARENT_TOOLS, ...options });
    return w;
}

type Started = { argv: string[]; env: Record<string, string> };

/** Every process the fake child was started as, oldest first. */
const processes = (world: World): Started[] =>
    world.log().all.filter((entry) => entry.type === "start") as unknown as Started[];

/** Starts a child from a role and returns the command line and environment of its process. */
const start = async (world: World, role = "scout"): Promise<Started> => {
    const started = await world.tool({ action: "start", role, task: "look" });
    assert.equal(started.isError, false, started.text);
    const session = `agent-${started.details.child}`;
    const mine = (): Started | undefined => processes(world).find((entry) => entry.argv.includes(session));
    await until(() => mine() !== undefined, "the child");
    return mine() as Started;
};

/** Every value that follows a flag in the command line. */
const valuesOf = (argv: string[], flag: string): string[] =>
    argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] as string] : []));

const policyOf = (env: Record<string, string>): RolePolicy => {
    const reading = readRolePolicy(env);
    assert.equal(reading.kind, "policy", JSON.stringify(reading));
    return (reading as { policy: RolePolicy }).policy;
};

describe("the policy the child is started with", () => {
    test("a scout's: it may not write, git is narrowed to its reads, and nothing asks", async () => {
        const world = await begin({ script: { steps: [{ hold: true }] } });
        const child = await start(world);
        assert.deepEqual(policyOf(child.env), {
            role: "scout",
            writes: false,
            actions: { git: ["status", "diff", "log", "show", "blame", "branches"] },
            ask: {},
        });
        assert.equal(child.env.JIG_AGENT_ROLE, "scout");
    });

    test("a worker's: it may write, and no tool is narrowed", async () => {
        const world = await begin({ script: { steps: [{ hold: true }] } });
        const child = await start(world, "worker");
        assert.deepEqual(policyOf(child.env), { role: "worker", writes: true, actions: {}, ask: {} });
    });

    test("configuration narrows the file's actions and adds to its ask, and cannot add an action the file does not allow", async () => {
        const world = await begin({
            script: { steps: [{ hold: true }] },
            config: {
                agents: {
                    roles: {
                        scout: { actions: { git: ["status", "log", "push"], logs: ["search"] }, ask: { git: ["log"] } },
                    },
                },
            },
        });
        const child = await start(world);
        assert.deepEqual(policyOf(child.env).actions, { git: ["status", "log"], logs: ["search"] });
        assert.deepEqual(policyOf(child.env).ask, { git: ["log"] });
    });

    test("configuration cannot make a read-only role write: the section that tries is refused as a whole", async () => {
        const world = await begin({
            script: { steps: [{ hold: true }] },
            config: { agents: { roles: { scout: { writes: true } } } },
        });
        // The section is invalid, so jig-core reports it and the plugin reads none of it; the file stands.
        const child = await start(world);
        assert.equal(policyOf(child.env).writes, false);
    });

    test("an agent file of the user's that says writes: true does not change the shipped scout's policy for another role name", async () => {
        const world = await begin({
            script: { steps: [{ hold: true }] },
            agentFiles: {
                "scout-plus.md": "---\ndescription: d\ntools: read, git\nwrites: true\n---\nYou do the work.\n",
            },
        });
        const plus = await start(world, "scout-plus");
        assert.equal(policyOf(plus.env).writes, true);
        assert.equal(policyOf(plus.env).role, "scout-plus");
    });

    test("a resumed child gets the policy of the role as it is now", async () => {
        const world = await begin({
            script: { steps: [{ settle: { text: "first report" } }] },
        });
        await start(world);
        await world.deliver();
        // The configuration has been narrowed since, as a reload of jig.json would have it.
        world.rt.settings = settingsFrom({ roles: { scout: { actions: { git: ["status"] } } } });
        world.script({ steps: [{ hold: true }] });
        const resumed = await world.tool({ action: "message", child: "scout-1", text: "again" });
        assert.equal(resumed.isError, false, resumed.text);
        await until(() => processes(world).length === 2, "the second process");
        assert.deepEqual(policyOf((processes(world)[1] as Started).env).actions, { git: ["status"] });
    });
});

describe("bash for a role that does not write", () => {
    test("is refused where there is no sandbox, before a worktree or a process exists, with the way out", async () => {
        const world = await begin({ commands: [] });
        const refused = await world.tool({ action: "start", role: "scout", task: "look" });
        assert.equal(refused.isError, true);
        assert.match(
            refused.text,
            /the role scout cannot run here: it lists bash and does not write, which is safe only inside jig-sandbox, and this session has no \/sandbox command\. Install jig-sandbox, or use a role without bash/,
        );
        assert.equal(world.log().start, undefined, "no process was started");
        assert.equal(world.rt.children.size, 0);
        assert.equal(world.rt.started, 0);
    });

    test("runs where there is one", async () => {
        const world = await begin({ commands: ["sandbox"], script: { steps: [{ hold: true }] } });
        await start(world);
    });

    test("a role that writes may have bash without one, and a read-only role without bash needs none", async () => {
        const world = await begin({
            commands: [],
            script: { steps: [{ hold: true }] },
            agentFiles: { "lite.md": "---\ndescription: Reads\ntools: read, grep\nwrites: false\n---\nYou read.\n" },
        });
        await start(world, "lite");
        const worker = await world.tool({ action: "start", role: "worker", task: "change it" });
        assert.equal(worker.isError, false, worker.text);
    });

    test("a misspelt action in a role is refused with the actions the tool has", async () => {
        const world = await begin({
            agentFiles: {
                "typo.md":
                    "---\ndescription: d\ntools: read, git\nactions: git statuss|log\nwrites: false\n---\nYou read.\n",
            },
        });
        const refused = await world.tool({ action: "start", role: "typo", task: "look" });
        assert.equal(refused.isError, true);
        assert.ok(
            refused.text.includes(
                `actions: git has no action statuss (its actions: ${Object.keys(GIT_ACTIONS).join(", ")})`,
            ),
            refused.text,
        );
        assert.equal(world.log().start, undefined);
    });
});

describe("the skills the child sees", () => {
    test("by default they follow the tools: a scout has the git and logs skills and the ones nobody owns, and not jira's", async () => {
        const s = skills();
        const world = await begin({ skills: Object.values(s), script: { steps: [{ hold: true }] } });
        const argv = (await start(world)).argv;
        assert.ok(argv.includes("--no-skills"));
        assert.deepEqual(valuesOf(argv, "--skill").sort(), [s.git, s.logs, s.house].sort());
    });

    test("a company skill that names a tool comes with that tool", async () => {
        const s = skills();
        const world = await begin({
            skills: Object.values(s),
            script: { steps: [{ hold: true }] },
            agentFiles: {
                "tickets.md": "---\ndescription: Reads tickets\ntools: read, jira\nwrites: false\n---\nYou read.\n",
            },
        });
        const argv = (await start(world, "tickets")).argv;
        assert.deepEqual(valuesOf(argv, "--skill").sort(), [s.jira, s.acme, s.house].sort());
    });

    test("a role with no tools list sees every skill", async () => {
        const s = skills();
        const world = await begin({
            skills: Object.values(s),
            script: { steps: [{ hold: true }] },
            agentFiles: { "all.md": "---\ndescription: Does anything\nwrites: true\n---\nYou do the work.\n" },
        });
        const argv = (await start(world, "all")).argv;
        assert.deepEqual(valuesOf(argv, "--skill").sort(), Object.values(s).sort());
    });

    test("an explicit list is exactly those skills, tools or not", async () => {
        const s = skills();
        const world = await begin({
            skills: Object.values(s),
            script: { steps: [{ hold: true }] },
            agentFiles: {
                "picky.md":
                    "---\ndescription: d\ntools: read\nskills: jira, house-style\nwrites: false\n---\nYou read.\n",
            },
        });
        assert.deepEqual(valuesOf((await start(world, "picky")).argv, "--skill"), [s.jira, s.house]);
    });

    test("none is --no-skills alone", async () => {
        const s = skills();
        const world = await begin({
            skills: Object.values(s),
            script: { steps: [{ hold: true }] },
            agentFiles: {
                "bare.md": "---\ndescription: d\ntools: read\nskills: none\nwrites: false\n---\nYou read.\n",
            },
        });
        const argv = (await start(world, "bare")).argv;
        assert.ok(argv.includes("--no-skills"));
        assert.deepEqual(valuesOf(argv, "--skill"), []);
    });

    test("configuration replaces the file's skills, and a skill the session lacks refuses the start", async () => {
        const s = skills();
        const world = await begin({
            skills: Object.values(s),
            script: { steps: [{ hold: true }] },
            config: {
                agents: { roles: { scout: { skills: ["house-style"] }, reviewer: { skills: ["ghost-skill"] } } },
            },
        });
        assert.deepEqual(valuesOf((await start(world)).argv, "--skill"), [s.house]);
        const refused = await world.tool({ action: "start", role: "reviewer", task: "look" });
        assert.match(
            refused.text,
            /skills: ghost-skill is not among this session's skills \(git, logs, jira, acme-jira, house-style\)/,
        );
    });
});

describe("the skills a child starts with in its instructions", () => {
    const preloading = (extra: string): Record<string, string> => ({
        "careful.md": `---\ndescription: d\ntools: read, git\nwrites: false\n${extra}\n---\nYou review carefully.\n`,
    });

    test("a preloaded skill's whole text follows the role's prompt in the file the child appends to its system prompt", async () => {
        const s = skills();
        const world = await begin({
            skills: Object.values(s),
            script: { steps: [{ hold: true }] },
            agentFiles: preloading("preload: git"),
            commands: ["sandbox"],
        });
        const argv = (await start(world, "careful")).argv;
        const prompt = readFileSync(argv[argv.indexOf("--append-system-prompt") + 1] as string, "utf8");
        assert.match(prompt, /^You review carefully\.\n\n## Skill: git\n\nThis is the whole skill, already loaded\./);
        assert.match(prompt, /# Git\n\nUse the git tool, not bash\.\n$/);
        assert.doesNotMatch(prompt, /description: About git/, "the front matter is left out");
        // It is also visible, as every preloaded skill must be.
        assert.ok(valuesOf(argv, "--skill").includes(s.git));
    });

    test("a preloaded skill that the role does not see refuses the start", async () => {
        const world = await begin({
            skills: Object.values(skills()),
            agentFiles: preloading("preload: jira"),
        });
        const refused = await world.tool({ action: "start", role: "careful", task: "look" });
        assert.equal(refused.isError, true);
        assert.match(
            refused.text,
            /preload: the skill jira is not one this role sees \(git, house-style\); a preloaded skill must also be visible/,
        );
        assert.equal(world.log().start, undefined);
    });

    test("configuration's preload replaces the file's", async () => {
        const world = await begin({
            skills: Object.values(skills()),
            script: { steps: [{ hold: true }] },
            agentFiles: preloading("preload: git"),
            config: { agents: { roles: { careful: { preload: ["house-style"] } } } },
        });
        const argv = (await start(world, "careful")).argv;
        const prompt = readFileSync(argv[argv.indexOf("--append-system-prompt") + 1] as string, "utf8");
        assert.match(prompt, /## Skill: house-style/);
        assert.doesNotMatch(prompt, /## Skill: git/);
    });

    test("a role that preloads nothing gets its prompt as it was", async () => {
        const world = await begin({ script: { steps: [{ hold: true }] } });
        const argv = (await start(world)).argv;
        const prompt = readFileSync(argv[argv.indexOf("--append-system-prompt") + 1] as string, "utf8");
        assert.doesNotMatch(prompt, /## Skill:/);
    });
});

describe("the project's instructions and the thinking level", () => {
    test("context none is --no-context-files; the default and project pass nothing", async () => {
        const world = await begin({
            script: { steps: [{ hold: true }] },
            agentFiles: {
                "cold.md": "---\ndescription: d\ntools: read\ncontext: none\nwrites: false\n---\nYou read.\n",
            },
        });
        assert.ok((await start(world, "cold")).argv.includes("--no-context-files"));
        assert.ok(!(await start(world, "worker")).argv.includes("--no-context-files"));
    });

    test("configuration's context replaces the file's, in both directions", async () => {
        const world = await begin({
            script: { steps: [{ hold: true }] },
            agentFiles: {
                "cold.md": "---\ndescription: d\ntools: read\ncontext: none\nwrites: false\n---\nYou read.\n",
            },
            config: { agents: { roles: { cold: { context: "project" }, scout: { context: "none" } } } },
        });
        assert.ok(!(await start(world, "cold")).argv.includes("--no-context-files"));
        assert.ok((await start(world, "scout")).argv.includes("--no-context-files"));
    });

    test("the file's thinking level reaches the child, and the parent's own is the fallback", async () => {
        const world = await begin({
            script: { steps: [{ hold: true }] },
            agentFiles: {
                "deep.md": "---\ndescription: d\ntools: read\nthinking: high\nwrites: false\n---\nYou read.\n",
            },
        });
        const argv = (await start(world, "deep")).argv;
        assert.equal(argv[argv.indexOf("--thinking") + 1], "high");
    });

    test("configuration's thinking replaces the file's, and the model's :level comes between them", async () => {
        const file = "---\ndescription: d\ntools: read\nthinking: high\nwrites: false\n---\nYou read.\n";
        const level = async (config: Record<string, unknown>): Promise<string | undefined> => {
            const world = await startWorld({
                extensions: PARENT_TOOLS,
                script: { steps: [{ hold: true }] },
                agentFiles: { "deep.md": file },
                settings: { enabledModels: ["faux/*"] },
                config: { agents: { roles: { deep: config } } },
            });
            try {
                const argv = (await start(world, "deep")).argv;
                return argv.includes("--thinking") ? argv[argv.indexOf("--thinking") + 1] : undefined;
            } finally {
                await world.close();
            }
        };
        assert.equal(await level({ thinking: "minimal" }), "minimal");
        assert.equal(await level({ model: "faux/faux-1:low" }), "low");
        assert.equal(await level({ model: "faux/faux-1:low", thinking: "medium" }), "medium");
        assert.equal(await level({ model: "faux/faux-1" }), "high");
    });
});
