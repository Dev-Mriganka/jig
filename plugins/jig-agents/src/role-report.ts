// `/agents roles`: each role as it would run in this session, with where every value came from (the agent file, or configuration), the
// skills it would see once they are worked out, and anything that would stop a child from starting. The same facts a start uses.
import { stripControl } from "./clean.ts";
import { limitsFor, parseModel } from "./config.ts";
import { viewRole } from "./role-plan.ts";
import type { RoleView } from "./role-plan.ts";
import type { Source } from "./policy.ts";
import type { Runtime } from "./runtime.ts";
import { requiredCommands } from "./start-plan.ts";
import type { ActionMap } from "../../jig-core/src/kit/role-policy.ts";

/** `git status|log, jira get`: the one-line form of an agent file, or `none`. */
function mapText(map: ActionMap, none: string): string {
    const parts = Object.entries(map).map(
        ([tool, actions]) => `${tool} ${actions.length === 0 ? "(none)" : actions.join("|")}`,
    );
    return parts.length === 0 ? none : parts.join(", ");
}

const where = (source: Source): string => (source === "default" ? "default" : source);

/** The thinking level and where it comes from: configuration's own field, the configured model's suffix, the file, or the parent's. */
function thinkingLine(view: RoleView, model: string | undefined): string {
    const { thinking, from } = view.effective;
    if (from.thinking === "configuration") return `${thinking} (configuration)`;
    const suffix = model === undefined ? undefined : parseModel(model)?.thinking;
    if (suffix !== undefined) return `${suffix} (configuration, the model's :${suffix})`;
    return thinking === undefined ? "the parent's (default)" : `${thinking} (${where(from.thinking)})`;
}

function skillsLine(view: RoleView): string {
    const names = view.skills.visible.map((skill) => skill.name);
    const source = view.effective.from.skills;
    return `${names.length === 0 ? "none" : names.join(", ")} (${view.skills.basis}${source === "default" ? "" : `; ${source}`})`;
}

/** The roles, with where each value came from and the problems of the files that were skipped. */
export function roleReport(rt: Runtime): string {
    const lines: string[] = [];
    const commands = requiredCommands(rt.pi);
    for (const role of rt.roles.roles.values()) {
        const own = rt.settings.roles[role.name];
        const view = viewRole(rt.pi, role, own, commands);
        const { effective } = view;
        const limits = limitsFor(rt.settings, role.name);
        lines.push(
            `${role.name}${role.writes ? " (writes)" : " (read-only)"}: ${stripControl(role.description)}`,
            `  file: ${role.file}`,
            `  tools: ${role.tools === undefined ? "the usual tools" : role.tools.join(", ")} (file)`,
            `  writes: ${role.writes ? "yes" : "no"} (file)`,
            `  actions: ${mapText(effective.actions, "every action of every tool")} (${where(effective.from.actions)})`,
            `  ask: ${mapText(effective.ask, "none")} (${where(effective.from.ask)})`,
            `  skills: ${skillsLine(view)}`,
            `  preload: ${effective.preload.length === 0 ? "none" : effective.preload.join(", ")} (${where(effective.from.preload)})`,
            `  context: ${effective.context} (${where(effective.from.context)})`,
            `  thinking: ${thinkingLine(view, own?.model)}`,
            `  model: ${own?.model ?? "the parent's"}${own?.model === undefined ? "" : " (configuration)"}; limits: ${limits.maxTurns} turns, ${limits.maxMinutes} min, $${limits.maxCost}`,
        );
        for (const problem of view.problems) lines.push(`  warning: ${stripControl(problem)}`);
    }
    for (const name of Object.keys(rt.settings.roles)) {
        if (!rt.roles.roles.has(name))
            lines.push(`warning: agents.roles.${name} is set in jig.json, but no agent file defines the role ${name}`);
    }
    for (const problem of rt.roles.problems) lines.push(`skipped ${problem.file}: ${stripControl(problem.problem)}`);
    return lines.length === 0 ? "No roles." : lines.join("\n");
}
