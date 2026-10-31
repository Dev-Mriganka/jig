// Which skills a child sees. Pi advertises every skill it finds to the model, so a child for a narrow job would carry the skills of every
// tool it cannot call. The parent works out the list and starts the child with `--no-skills` and one `--skill` for each skill it keeps.
//
//   skills: none            no skill
//   skills: a, b            exactly these
//   (absent)                those that follow the role's tools: a skill that belongs to a plugin is seen only when the role has a tool
//                           that plugin registers. A skill with no known owner is always seen, and so is every skill for a role with
//                           no tools list (a writer with all the tools).
//
// A skill belongs to a plugin in one of two ways: it sits in `plugins/<plugin>/skills/`, as Jig's own do, or it names the tool it extends
// in its front matter, which is how a company's skill says it. Pi's parser accepts the field because the Agent Skills format keeps
// `metadata` for exactly this:
//
//   metadata:
//     jig-tool: jira
//
// Pi has no call that gives an extension a skill's front matter, only its name, description and path (`pi.getCommands()` lists them), so
// the field is read from the skill's file here.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME_PATTERN } from "../../jig-core/src/kit/role-policy.ts";
import type { SkillChoice } from "./config.ts";

/** The front matter key, under `metadata`, that names the tools a skill extends. */
export const SKILL_TOOL_KEY = "jig-tool";
/** A skill's file is read as far as this to find its front matter. */
const FRONT_MATTER_BYTES = 16 * 1024;
/** A skill preloaded into a child's instructions may not be longer than this. */
export const MAX_PRELOAD_BYTES = 64 * 1024;

export interface SkillInfo {
    name: string;
    /** The skill's file (`SKILL.md`). */
    file: string;
    /** The Jig plugin whose `skills/` folder holds it, when it is in one. */
    plugin?: string;
    /** The tools its front matter says it extends. They come before the plugin. */
    tools?: string[];
}

/** The tools a plugin declared, as `jig().tools.declared()` gives them. */
export type DeclaredTools = ReadonlyArray<{ readonly tool: string; readonly plugin: string }>;

function unquote(value: string): string {
    const v = value.trim();
    return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1).trim() : v;
}

/** The text between the `---` lines at the top of a file, as Pi finds it, or undefined when there is none. */
export function frontMatterOf(text: string): string | undefined {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
    if (!normalized.startsWith("---")) return undefined;
    const end = normalized.indexOf("\n---", 3);
    return end < 0 ? undefined : normalized.slice(4, end);
}

/** The text of a skill without its front matter. */
export function bodyOf(text: string): string {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
    if (!normalized.startsWith("---")) return normalized.trim();
    const end = normalized.indexOf("\n---", 3);
    return end < 0 ? normalized.trim() : normalized.slice(end + 4).trim();
}

/** The tools `metadata.jig-tool` names, in the block form or the one-line form; undefined when it names none or names a bad one. */
export function toolsNamedBy(front: string): string[] | undefined {
    let value: string | undefined;
    const block = /^metadata:[ \t]*(?:#.*)?\n((?:[ \t]+.*(?:\n|$))*)/m.exec(front);
    if (block !== null) {
        value = new RegExp(`^[ \\t]+${SKILL_TOOL_KEY}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(block[1] ?? "")?.[1];
    } else {
        const flow = /^metadata:[ \t]*\{(.*)\}[ \t]*$/m.exec(front);
        value = new RegExp(`(?:^|,)\\s*${SKILL_TOOL_KEY}:\\s*("[^"]*"|'[^']*'|[^,}]*)`).exec(flow?.[1] ?? "")?.[1];
    }
    if (value === undefined) return undefined;
    const names = unquote(value)
        .split(",")
        .map((name) => unquote(name))
        .filter((name) => name !== "");
    return names.length > 0 && names.every((name) => TOOL_NAME_PATTERN.test(name)) ? [...new Set(names)] : undefined;
}

/** The plugin whose `skills/` folder a skill file is in: `.../plugins/<plugin>/skills/...`. */
export function pluginOf(file: string): string | undefined {
    const pattern = /(?:^|[\\/])plugins[\\/]([A-Za-z0-9_-]+)[\\/]skills[\\/]/;
    const named = pattern.exec(file)?.[1];
    if (named !== undefined) return named;
    try {
        return pattern.exec(realpathSync(file))?.[1];
    } catch {
        return undefined;
    }
}

function readStart(file: string): string | undefined {
    try {
        return readFileSync(file).subarray(0, FRONT_MATTER_BYTES).toString("utf8");
    } catch {
        return undefined;
    }
}

/**
 * The skills Pi found in this session, with where each is. Pi lists them with its commands (`skill:<name>`), each with the path of its
 * file; that is the only way an extension is told which skills exist. A parent that cannot list its commands has none to give.
 */
export function listSkills(pi: ExtensionAPI): SkillInfo[] {
    let commands: ReturnType<ExtensionAPI["getCommands"]>;
    try {
        commands = pi.getCommands();
    } catch {
        return [];
    }
    const skills: SkillInfo[] = [];
    for (const command of commands) {
        const file = command.source === "skill" ? command.sourceInfo?.path : undefined;
        if (typeof file !== "string" || !path.isAbsolute(file)) continue;
        const info: SkillInfo = { name: command.name.replace(/^skill:/, ""), file };
        const plugin = pluginOf(file);
        if (plugin !== undefined) info.plugin = plugin;
        const front = readStart(file);
        const tools = front === undefined ? undefined : toolsNamedBy(frontMatterOf(front) ?? "");
        if (tools !== undefined) info.tools = tools;
        skills.push(info);
    }
    return skills;
}

/** Whether a skill belongs to the tools a role has. A skill with no known owner always does. */
export function followsTools(skill: SkillInfo, roleTools: readonly string[], declared: DeclaredTools): boolean {
    const its =
        skill.tools ??
        (skill.plugin === undefined
            ? []
            : declared.filter((entry) => entry.plugin === skill.plugin).map((entry) => entry.tool));
    return its.length === 0 || its.some((tool) => roleTools.includes(tool));
}

/** How the visible list was chosen, in words for `/agents roles`. */
export type Basis = "every skill (no tools list)" | "those that follow the tools" | "none" | "the ones listed";

export interface Resolved {
    visible: SkillInfo[];
    basis: Basis;
    /** Names the role lists that this session does not have. */
    missing: string[];
}

/** The skills a role sees, from what the session has. */
export function resolveSkills(
    choice: SkillChoice | undefined,
    roleTools: readonly string[] | undefined,
    available: readonly SkillInfo[],
    declared: DeclaredTools,
): Resolved {
    if (choice === "none") return { visible: [], basis: "none", missing: [] };
    if (Array.isArray(choice)) {
        const visible = choice.flatMap((name) => available.filter((skill) => skill.name === name).slice(0, 1));
        return {
            visible,
            basis: "the ones listed",
            missing: choice.filter((name) => !available.some((skill) => skill.name === name)),
        };
    }
    if (roleTools === undefined) return { visible: [...available], basis: "every skill (no tools list)", missing: [] };
    return {
        visible: available.filter((skill) => followsTools(skill, roleTools, declared)),
        basis: "those that follow the tools",
        missing: [],
    };
}

export interface Preloaded {
    name: string;
    /** The skill's folder, which paths in its text are relative to. */
    dir: string;
    body: string;
}

/** The full text of the skills a role preloads, or what is wrong with one of them. */
export function readPreloads(
    names: readonly string[],
    visible: readonly SkillInfo[],
): { loaded: Preloaded[]; problems: string[] } {
    const loaded: Preloaded[] = [];
    const problems: string[] = [];
    for (const name of names) {
        const skill = visible.find((entry) => entry.name === name);
        if (skill === undefined) {
            problems.push(
                `preload: the skill ${name} is not one this role sees (${visible.map((entry) => entry.name).join(", ") || "it sees none"}); a preloaded skill must also be visible`,
            );
            continue;
        }
        let text: string;
        try {
            const bytes = readFileSync(skill.file);
            if (bytes.length > MAX_PRELOAD_BYTES) {
                problems.push(`preload: the skill ${name} is longer than ${MAX_PRELOAD_BYTES / 1024} KiB`);
                continue;
            }
            text = bytes.toString("utf8");
        } catch {
            problems.push(`preload: the skill ${name} cannot be read from ${skill.file}`);
            continue;
        }
        loaded.push({ name, dir: path.dirname(skill.file), body: bodyOf(text) });
    }
    return { loaded, problems };
}

/** The role's prompt with each preloaded skill added under a heading of its own. */
export function promptWith(rolePrompt: string, preloaded: readonly Preloaded[]): string {
    const sections = preloaded.map(
        (skill) =>
            `## Skill: ${skill.name}\n\nThis is the whole skill, already loaded. A path in it is relative to its folder, ${skill.dir}.\n\n${skill.body}`,
    );
    return [rolePrompt, ...sections].join("\n\n");
}
