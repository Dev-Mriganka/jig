// How jig-core classifies a call: where it acts and whether it reads or writes. The same table that lists the actions
// (params.ts) says which are reads. Writes ask by default, because their environment is `external`.
import type { CallClass } from "../../jig-core/src/contract.ts";
import { DEFAULT_ENVIRONMENT } from "./config.ts";
import type { JiraSettings } from "./config.ts";
import { fieldIdOf } from "./fields.ts";
import { ACTIONS, isAction } from "./params.ts";

/** True when the call sets the description. Its text is long and read by many people, so it gets the review screen. */
function setsDescription(fields: unknown, settings: JiraSettings | undefined): boolean {
    if (typeof fields !== "object" || fields === null) return false;
    return Object.keys(fields).some((name) => fieldIdOf(name, settings?.fields ?? {}) === "description");
}

/**
 * Pure and quick, as jig-core requires. An action this tool does not have is undefined, which makes the call unknown,
 * and an unknown call asks. Text writes use the review screen, where the text can be read rendered; the other writes
 * use a one-line dialog.
 */
export function classifyCall(
    input: Readonly<Record<string, unknown>>,
    settings: JiraSettings | undefined,
): CallClass | undefined {
    const { action } = input;
    if (!isAction(action)) return undefined;
    const environment = settings?.environment ?? DEFAULT_ENVIRONMENT;
    if (ACTIONS[action].kind === "read") return { action, environment, effect: "read" };
    const text = action === "create" || action === "comment" || action === "edit_comment";
    const reviewed = text || (action === "update" && setsDescription(input.fields, settings));
    return { action, environment, effect: "write", approval: reviewed ? "review" : "dialog" };
}
