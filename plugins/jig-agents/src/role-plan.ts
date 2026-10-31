// What a role comes to when a child is started from it: configuration laid over the agent file (policy.ts), the skills the child will see
// (skills.ts), the policy it will enforce, and its prompt with the skills it preloads. Everything is worked out in the parent before a
// process or a worktree exists, so a role that cannot run is refused with the sentence that says why, and `/agents roles` shows the
// same facts and the same warnings.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jig } from "../../jig-core/src/client.ts";
import { writeRolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import type { RoleSettings } from "./config.ts";
import { StartError } from "./launch.ts";
import { effectiveRole, policyOf } from "./policy.ts";
import type { Effective } from "./policy.ts";
import { SANDBOXED_TOOLS } from "./roles.ts";
import type { Role } from "./roles.ts";
import { listSkills, promptWith, readPreloads, resolveSkills } from "./skills.ts";
import type { DeclaredTools, Preloaded, Resolved } from "./skills.ts";

export interface RoleView {
    effective: Effective;
    skills: Resolved;
    preloaded: Preloaded[];
    /** Why the role cannot run in this session, one sentence each. Empty when it can. */
    problems: string[];
}

export interface RolePlan extends RoleView {
    /** The text of the child's `JIG_ROLE_POLICY`. */
    policy: string;
    /** The prompt file's text: the role's prompt, then each preloaded skill. */
    prompt: string;
}

/** The tools plugins declared to jig-core, or none when jig-core cannot say. */
function declaredTools(): DeclaredTools {
    try {
        return jig().tools?.declared() ?? [];
    } catch {
        return [];
    }
}

/** The actions a tool's `action` parameter allows, from the schema Pi has for it. Undefined when the tool or its list is not known. */
function actionsOf(pi: ExtensionAPI, tool: string): string[] | undefined {
    let found: ReturnType<ExtensionAPI["getAllTools"]>[number] | undefined;
    try {
        found = pi.getAllTools().find((candidate) => candidate.name === tool);
    } catch {
        return undefined;
    }
    const values = (found?.parameters as { properties?: { action?: { enum?: unknown } } } | undefined)?.properties
        ?.action?.enum;
    return Array.isArray(values) && values.every((value) => typeof value === "string")
        ? (values as string[])
        : undefined;
}

/** The actions a role names that their tool does not have: a misspelt action would otherwise refuse everything or ask about nothing. */
function unknownActions(pi: ExtensionAPI, effective: Effective): string[] {
    const out: string[] = [];
    for (const [field, map] of [
        ["actions", effective.actions],
        ["ask", effective.ask],
    ] as const) {
        for (const [tool, wanted] of Object.entries(map)) {
            const known = actionsOf(pi, tool);
            const bad = known === undefined ? [] : wanted.filter((action) => !known.includes(action));
            if (bad.length > 0) {
                out.push(`${field}: ${tool} has no action ${bad.join(", ")} (its actions: ${known?.join(", ")})`);
            }
        }
    }
    return out;
}

/** The role as it would run in this session, and what stops it. `commands` are the commands the parent has (see `requiredCommands`). */
export function viewRole(
    pi: ExtensionAPI,
    role: Role,
    own: RoleSettings | undefined,
    commands: readonly string[],
): RoleView {
    const effective = effectiveRole(role, own);
    const available = listSkills(pi);
    const skills = resolveSkills(effective.skills, effective.tools, available, declaredTools());
    const problems: string[] = [];
    const shell = effective.tools?.filter((tool) => SANDBOXED_TOOLS.includes(tool)) ?? [];
    if (!effective.writes && shell.length > 0 && !commands.includes("sandbox")) {
        problems.push(
            `it lists ${shell.join(", ")} and does not write, which is safe only inside jig-sandbox, and this session has no /sandbox command. Install jig-sandbox, or use a role without ${shell.join(", ")}`,
        );
    }
    problems.push(...unknownActions(pi, effective));
    if (skills.missing.length > 0) {
        const have = available.map((skill) => skill.name).join(", ") || "it has none";
        problems.push(
            `skills: ${skills.missing.join(", ")} ${skills.missing.length === 1 ? "is" : "are"} not among this session's skills (${have})`,
        );
    }
    const preloads = readPreloads(effective.preload, skills.visible);
    problems.push(...preloads.problems);
    return { effective, skills, preloaded: preloads.loaded, problems };
}

/** The plan for a child, or a `StartError` that says what is wrong with the role. */
export function planRole(
    pi: ExtensionAPI,
    role: Role,
    own: RoleSettings | undefined,
    commands: readonly string[],
): RolePlan {
    const view = viewRole(pi, role, own, commands);
    if (view.problems.length > 0)
        throw new StartError(`the role ${role.name} cannot run here: ${view.problems.join("; ")}`);
    return {
        ...view,
        policy: writeRolePolicy(policyOf(view.effective)),
        prompt: promptWith(role.prompt, view.preloaded),
    };
}
