// What a role really is once configuration is laid over its agent file. The rule is Codex's: a role may customise its child or reduce
// what it can do, never replace the parent's authority. So what limits the child (writes, actions, ask) only ever narrows, and what
// only chooses what the child reads (skills, preload, context, thinking) is replaced by configuration, since that is not authority.
//
//   writes   the file's, and nothing in configuration can change it
//   actions  the file's, narrowed: a tool in both keeps the actions both list; a tool only configuration lists is narrowed to its list
//   ask      the file's and configuration's together
//   skills, preload, context, thinking   configuration's when it gives one, else the file's
//
// `policyOf` is the part the child enforces; the rest is read by the parent when it starts the child.
import type { ActionMap, RolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import type { ContextMode, RoleSettings, SkillChoice } from "./config.ts";
import type { Role } from "./roles.ts";

/** Where a value of the effective role came from, as `/agents roles` says it. */
export type Source = "file" | "configuration" | "file and configuration" | "default";

export interface Effective {
    role: Role;
    writes: boolean;
    tools: string[] | undefined;
    actions: ActionMap;
    ask: ActionMap;
    /** Absent: the skills that follow the role's tools. */
    skills: SkillChoice | undefined;
    preload: string[];
    context: ContextMode;
    /** The role's own thinking level (configuration's, else the file's). A `:thinking` on the configured model comes before the file's. */
    thinking: string | undefined;
    from: {
        actions: Source;
        ask: Source;
        skills: Source;
        preload: Source;
        context: Source;
        thinking: Source;
    };
}

/** Where a value came from, for a value that configuration replaces. */
function replaced<T>(file: T | undefined, configured: T | undefined): { value: T | undefined; from: Source } {
    if (configured !== undefined) return { value: configured, from: "configuration" };
    return file === undefined ? { value: undefined, from: "default" } : { value: file, from: "file" };
}

/** Both maps' tools; a tool in both keeps `join` of the two lists. */
function combine(
    file: ActionMap | undefined,
    configured: ActionMap | undefined,
    join: (fromFile: readonly string[], fromConfiguration: readonly string[]) => string[],
): { map: ActionMap; from: Source } {
    const map: ActionMap = {};
    for (const [tool, list] of Object.entries(file ?? {})) map[tool] = [...list];
    for (const [tool, list] of Object.entries(configured ?? {})) {
        map[tool] = Object.hasOwn(map, tool) ? join(map[tool] as string[], list) : [...list];
    }
    const hasFile = file !== undefined && Object.keys(file).length > 0;
    const hasConfiguration = configured !== undefined && Object.keys(configured).length > 0;
    const from: Source =
        hasFile && hasConfiguration
            ? "file and configuration"
            : hasFile
              ? "file"
              : hasConfiguration
                ? "configuration"
                : "default";
    return { map, from };
}

/** Actions both lists name: configuration can narrow what the file allows and cannot add to it. */
export const intersection = (fromFile: readonly string[], fromConfiguration: readonly string[]): string[] =>
    fromFile.filter((action) => fromConfiguration.includes(action));

/** Actions either list names. */
export const union = (fromFile: readonly string[], fromConfiguration: readonly string[]): string[] => [
    ...new Set([...fromFile, ...fromConfiguration]),
];

/** The role with configuration laid over it: narrower in what it may do, and with the reading replaced. */
export function effectiveRole(role: Role, own: RoleSettings | undefined): Effective {
    const actions = combine(role.actions, own?.actions, intersection);
    const ask = combine(role.ask, own?.ask, union);
    const skills = replaced<SkillChoice>(role.skills, own?.skills);
    const preload = replaced<string[]>(role.preload, own?.preload);
    const context = replaced<ContextMode>(role.context, own?.context);
    const thinking = replaced<string>(role.thinking, own?.thinking);
    return {
        role,
        // Never from configuration: a role that does not write in its file does not write, whoever configures it.
        writes: role.writes,
        tools: role.tools === undefined ? undefined : [...role.tools],
        actions: actions.map,
        ask: ask.map,
        skills: skills.value,
        preload: preload.value ?? [],
        context: context.value ?? "project",
        thinking: thinking.value,
        from: {
            actions: actions.from,
            ask: ask.from,
            skills: skills.from,
            preload: preload.from,
            context: context.from,
            thinking: thinking.from,
        },
    };
}

/** What the child enforces. */
export function policyOf(effective: Effective): RolePolicy {
    return { role: effective.role.name, writes: effective.writes, actions: effective.actions, ask: effective.ask };
}
