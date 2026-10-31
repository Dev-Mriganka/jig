// What a start needs worked out before any process exists: a free name and id, the working folder (inside the parent's), the model the
// child will run, the commands its parent has, and the task text the child is given. Each one only reads what it is given and throws a
// `StartError` that the parent agent reads, so the runtime's `start` is the order of the steps and none of their detail.
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { oneLine } from "./clean.ts";
import type { ChildSpec } from "./child-types.ts";
import { NAME_PATTERN } from "./config.ts";
import type { AgentsSettings } from "./config.ts";
import { chooseModel, readEnabledModels, StartError } from "./launch.ts";
import type { ModelChoice, ParentModel } from "./launch.ts";
import type { Role } from "./roles.ts";

export function generateId(taken: (id: string) => boolean): string {
    for (;;) {
        const id = randomBytes(4).toString("hex").slice(0, 6);
        if (!taken(id)) return id;
    }
}

/** The name a child goes by: the one given, if it is well formed and free, else `role-1`, `role-2`, ... */
export function nameFor(role: string, given: string | undefined, taken: (name: string) => boolean): string {
    if (given !== undefined) {
        if (!NAME_PATTERN.test(given))
            throw new StartError(`name "${oneLine(given, 40)}" must be letters, digits, - and _ (at most 40)`);
        if (taken(given)) throw new StartError(`a child named ${given} exists already in this session`);
        return given;
    }
    for (let n = 1; ; n++) {
        const name = `${role}-${n}`;
        if (!taken(name)) return name;
    }
}

/** The folder a child works in: the parent's, or one inside it. */
export function resolveCwd(ctx: ExtensionContext, requested: string | undefined): string {
    let base: string;
    try {
        base = realpathSync(ctx.cwd);
    } catch {
        throw new StartError(`the working folder ${ctx.cwd} cannot be read`);
    }
    if (requested === undefined) return base;
    let target: string;
    try {
        target = realpathSync(path.resolve(base, requested));
    } catch {
        throw new StartError(`cwd ${oneLine(requested, 80)} does not exist`);
    }
    const relative = path.relative(base, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new StartError(`cwd must be inside the working folder ${base}: a wider folder would widen the child`);
    }
    if (!statSync(target).isDirectory()) throw new StartError(`cwd ${oneLine(requested, 80)} is not a folder`);
    return target;
}

function parentModel(ctx: ExtensionContext, pi: ExtensionAPI): ParentModel | undefined {
    const model = ctx.model;
    if (model === undefined) return undefined;
    const thinking =
        ctx.thinkingLevel ?? (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined);
    return { provider: model.provider, id: model.id, ...(thinking === undefined ? {} : { thinking }) };
}

/** The model a role's child runs, and a refusal when Pi does not know the model the configuration names. */
export function modelFor(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    settings: AgentsSettings,
    agentDir: string,
    role: Pick<Role, "name" | "thinking">,
): ModelChoice | undefined {
    const choice = chooseModel(settings, role.name, parentModel(ctx, pi), readEnabledModels(agentDir), role.thinking);
    if (choice?.source === "role") {
        const [provider = "", ...rest] = choice.model.split("/");
        const known = ctx.modelRegistry?.find?.(provider, rest.join("/"));
        if (typeof ctx.modelRegistry?.find === "function" && known === undefined) {
            throw new StartError(
                `Pi does not know the model ${choice.model} that agents.roles.${role.name}.model names`,
            );
        }
    }
    return choice;
}

/** The commands a child must list before it gets its task: jig-core's, and jig-sandbox's when the parent has it. */
export function requiredCommands(pi: ExtensionAPI): string[] {
    let have: string[] = [];
    try {
        have = typeof pi.getCommands === "function" ? pi.getCommands().map((command) => command.name) : [];
    } catch {
        // The list is a check, and a parent that cannot give it checks jig-core's command alone.
    }
    return have.includes("sandbox") ? ["jig", "sandbox"] : ["jig"];
}

/** The first message a child gets: its task, how its report is used, and its limits. */
export function taskPrompt(role: Role, name: string, task: string, spec: ChildSpec): string {
    const lines = [
        `Task from your parent agent. You are the "${role.name}" subagent "${name}".`,
        "",
        task,
        "",
        "---",
        "Your last message is your report, and it is sent to the parent as it is. Put the answer first, then the evidence.",
        `You may use at most ${spec.limits.maxTurns} turns, ${spec.limits.maxMinutes} minutes and $${spec.limits.maxCost} of model cost; at a limit you are told to write your report, and then you are stopped.`,
        "If an action needs a person's permission, ask as you normally do: the question goes to the user, and a no is a no.",
    ];
    if (spec.branch !== undefined) {
        lines.push(
            `This folder is a git worktree on the branch ${spec.branch}, cut from the parent's HEAD. Changes the parent has not committed are not here. Commit your work on this branch.`,
        );
    }
    return lines.join("\n");
}
