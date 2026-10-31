// Roles are agent files: Markdown with a few fields of front matter and a prompt. They are read from three places and never from the
// project, which the model can write. Model, limits and extensions are not fields: they come from configuration, or are not allowed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAME_PATTERN } from "./config.ts";

export interface Role {
    name: string;
    /** One line the parent agent reads. */
    description: string;
    /** The tools the child may use. Absent: the child's usual tools (only for a role that writes). */
    tools?: string[];
    writes: boolean;
    /** The system prompt addition: the Markdown body. */
    prompt: string;
    /** The file it came from. */
    file: string;
}

export interface RoleProblem {
    file: string;
    problem: string;
}

export interface LoadedRoles {
    roles: Map<string, Role>;
    problems: RoleProblem[];
}

const FIELDS: ReadonlySet<string> = new Set(["name", "description", "tools", "writes"]);
/** What the files may not say: these belong to configuration or are not allowed at all. */
const FORBIDDEN: Readonly<Record<string, string>> = {
    model: "the model comes from configuration (agents.roles.<role>.model), never from an agent file",
    thinking: "the thinking level is part of the model setting in configuration",
    limits: "limits come from configuration (agents.limits and agents.roles.<role>)",
    maxTurns: "limits come from configuration (agents.limits and agents.roles.<role>)",
    maxMinutes: "limits come from configuration (agents.limits and agents.roles.<role>)",
    maxCost: "limits come from configuration (agents.limits and agents.roles.<role>)",
    extensions: "a child always loads the same plugins as its parent",
    approvals: "approvals come from configuration (agents.roles.<role>.approvals)",
};
/** Tools that write files or run commands. A role that does not write may not list them. */
export const WRITING_TOOLS: readonly string[] = ["bash", "powershell", "write", "edit", "notebook_edit"];
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOOLS = 40;

export class RoleError extends Error {}

function unquote(value: string): string {
    const v = value.trim();
    return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;
}

/** The front matter (`key: value` lines between two `---` lines) and the body. */
function split(text: string): { fields: Map<string, string>; body: string } {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines[0]?.trim() !== "---") throw new RoleError("the file must start with a --- line and front matter");
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end < 0) throw new RoleError("the front matter has no closing --- line");
    const fields = new Map<string, string>();
    for (const line of lines.slice(1, end)) {
        if (line.trim() === "" || line.trim().startsWith("#")) continue;
        const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
        if (match === null) throw new RoleError(`front matter line "${line.slice(0, 40)}" is not key: value`);
        const key = match[1] as string;
        if (fields.has(key)) throw new RoleError(`front matter field ${key} is given twice`);
        fields.set(key, match[2] as string);
    }
    return {
        fields,
        body: lines
            .slice(end + 1)
            .join("\n")
            .trim(),
    };
}

/** A role from a file's text. Throws a `RoleError` that names the field. `fallbackName` is the file name without `.md`. */
export function parseRole(text: string, file: string, fallbackName: string): Role {
    const { fields, body } = split(text);
    for (const key of fields.keys()) {
        const reason = FORBIDDEN[key];
        if (reason !== undefined) throw new RoleError(`${key}: ${reason}`);
        if (!FIELDS.has(key)) throw new RoleError(`${key}: unknown field (use name, description, tools, writes)`);
    }
    const name = unquote(fields.get("name") ?? fallbackName);
    if (!NAME_PATTERN.test(name)) throw new RoleError(`name: "${name.slice(0, 40)}" must be letters, digits, - and _`);
    const description = unquote(fields.get("description") ?? "");
    if (description === "" || description.length > 200 || /[\u0000-\u001f\u007f]/.test(description)) {
        throw new RoleError("description: needed, one line of at most 200 characters");
    }
    const writesText = unquote(fields.get("writes") ?? "false");
    if (writesText !== "true" && writesText !== "false") throw new RoleError("writes: must be true or false");
    const writes = writesText === "true";

    let tools: string[] | undefined;
    const rawTools = fields.get("tools");
    if (rawTools !== undefined) {
        const list = rawTools.trim().replace(/^\[/, "").replace(/\]$/, "");
        tools = list
            .split(",")
            .map((tool) => unquote(tool))
            .filter((tool) => tool !== "");
        if (tools.length === 0 || tools.length > MAX_TOOLS)
            throw new RoleError(`tools: list 1 to ${MAX_TOOLS} tool names`);
        for (const tool of tools) {
            if (!TOOL_NAME.test(tool)) throw new RoleError(`tools: "${tool.slice(0, 40)}" is not a tool name`);
        }
        tools = [...new Set(tools)];
    }
    if (!writes) {
        if (tools === undefined) {
            throw new RoleError(
                "tools: a role that does not write needs a tools list, because the child's usual tools include bash, write and edit",
            );
        }
        const bad = tools.filter((tool) => WRITING_TOOLS.includes(tool));
        if (bad.length > 0) {
            throw new RoleError(`tools: a role with writes: false must not list ${bad.join(", ")}`);
        }
    }
    if (body === "") throw new RoleError("the prompt after the front matter is empty");
    return { name, description, ...(tools === undefined ? {} : { tools }), writes, prompt: body, file };
}

/** The agent files that ship with the plugin. */
export function shippedFolder(): string {
    return fileURLToPath(new URL("../agents", import.meta.url));
}

function readFolder(folder: string, into: LoadedRoles): void {
    let names: string[];
    try {
        names = readdirSync(folder).sort();
    } catch {
        return;
    }
    for (const entry of names) {
        if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
        const file = path.join(folder, entry);
        try {
            const info = statSync(file);
            if (!info.isFile()) continue;
            if (info.size > MAX_FILE_BYTES) throw new RoleError(`the file is larger than ${MAX_FILE_BYTES / 1024} KiB`);
            const role = parseRole(readFileSync(file, "utf8"), file, entry.slice(0, -3));
            into.roles.set(role.name, role);
        } catch (error) {
            into.problems.push({ file, problem: error instanceof Error ? error.message : String(error) });
        }
    }
}

/** Roles from the folders, lowest first: a later file with the same name replaces an earlier one. A bad file is skipped and named. */
export function loadRoles(folders: readonly string[]): LoadedRoles {
    const loaded: LoadedRoles = { roles: new Map(), problems: [] };
    for (const folder of folders) readFolder(folder, loaded);
    return loaded;
}

/** The folders, lowest first: the plugin's own, the configured ones, then the user's agent folder. */
export function roleFolders(
    configured: readonly string[],
    agentDir: string,
    shipped: string = shippedFolder(),
): string[] {
    return [shipped, ...configured, path.join(agentDir, "agents")];
}
