// What a tool with an `action` parameter accepts, written once: for each action its required parameters, its optional
// parameters and a one-line description. The table is the source of the check that refuses a call before it does
// anything (an unknown action, a parameter the action does not use, a missing required one) and of the action list in
// the parameter's description, so the two cannot drift apart.
//
//   const ACTIONS = { commit: { summary: "commit exact paths", required: ["paths", "message"], optional: ["repo"] } };
//   checkParams("git", ACTIONS, params);
//   // git commit needs paths. Usage: git commit {paths, message, repo?}

interface ActionSpec {
    /** A few words for the tool's action list. */
    summary: string;
    /** Parameters the action needs. */
    required?: readonly string[];
    /** Parameters the action also accepts. */
    optional?: readonly string[];
}

export type ActionTable = Readonly<Record<string, ActionSpec>>;

/** `{paths, message, repo?}`: required names bare, optional ones marked with `?`. */
function signature(spec: ActionSpec): string {
    return `{${[...(spec.required ?? []), ...(spec.optional ?? []).map((name) => `${name}?`)].join(", ")}}`;
}

function usageLine(tool: string, action: string, spec: ActionSpec): string {
    return `Usage: ${tool} ${action} ${signature(spec)}`;
}

/**
 * Refuses a call whose parameters do not fit its action, and returns the action. A parameter whose value is
 * `undefined` counts as absent. The checks run in this order: the action, the parameters it does not use, the missing
 * required ones. Each message ends with the usage line, so the model can correct the call at once.
 */
export function checkParams(tool: string, table: ActionTable, params: object): string {
    const input = params as Record<string, unknown>;
    const action = input.action;
    if (typeof action !== "string" || !Object.hasOwn(table, action)) {
        throw new Error(
            `${tool}: unknown action ${JSON.stringify(String(action).slice(0, 40))}; use one of ${Object.keys(table).join(", ")}`,
        );
    }
    const spec = table[action] as ActionSpec;
    const usage = usageLine(tool, action, spec);
    const accepted = new Set<string>(["action", ...(spec.required ?? []), ...(spec.optional ?? [])]);
    for (const [name, value] of Object.entries(input)) {
        if (value !== undefined && !accepted.has(name))
            throw new Error(`${tool} ${action} does not use ${name}. ${usage}`);
    }
    const missing = (spec.required ?? []).filter((name) => input[name] === undefined);
    if (missing.length > 0) throw new Error(`${tool} ${action} needs ${missing.join(", ")}. ${usage}`);
    return action;
}

/** One line per action with its parameters, in table order, for the `action` parameter's description. */
export function describeActions(table: ActionTable): string {
    return Object.entries(table)
        .map(([action, spec]) => {
            const names = (spec.required?.length ?? 0) + (spec.optional?.length ?? 0) > 0 ? ` ${signature(spec)}` : "";
            return `- ${action}${names}: ${spec.summary}`;
        })
        .join("\n");
}

/** Every parameter name that any action of the table uses, for a test that compares the table with the schema. */
export function parameterNames(table: ActionTable): Set<string> {
    return new Set(Object.values(table).flatMap((spec) => [...(spec.required ?? []), ...(spec.optional ?? [])]));
}
