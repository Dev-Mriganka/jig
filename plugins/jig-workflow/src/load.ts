// Reading workflow files. A folder holds one `<name>.json` per workflow; the folders are read in order and a later file with
// the same name replaces an earlier one. A file that does not pass is reported with its path and the key at fault, and the
// rest still load.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseWorkflow } from "./definition.ts";
import type { Workflow } from "./definition.ts";

/** Where a folder came from, for `/workflow list`. */
export type FolderSource = "configured" | "agent folder" | "project";

export interface WorkflowFolder {
    dir: string;
    source: FolderSource;
}

export interface LoadedWorkflow {
    workflow: Workflow;
    file: string;
    source: FolderSource;
}

export interface Failure {
    file: string;
    /** One line: the key at fault and why. The first problem of the file. */
    reason: string;
}

/** A name in `workflow.disabled`: the file that was left out, or none when no file defines the name. */
export interface Disabled {
    name: string;
    file?: string;
}

export interface Loaded {
    workflows: Map<string, LoadedWorkflow>;
    failures: Failure[];
    /** The names `workflow.disabled` lists, in the order it lists them. */
    disabled: Disabled[];
}

/** A workflow file is a few lines of JSON; anything larger is not one. */
const MAX_FILE_BYTES = 64 * 1024;

/** Reads the folders in order, then leaves out the workflows named in `disabled`, whichever folder their file is in. */
export function loadWorkflows(folders: readonly WorkflowFolder[], disabled: readonly string[] = []): Loaded {
    const workflows = new Map<string, LoadedWorkflow>();
    const failures: Failure[] = [];
    for (const folder of folders) {
        let names: string[];
        try {
            names = readdirSync(folder.dir)
                .filter((name) => name.endsWith(".json"))
                .sort();
        } catch {
            // A folder that is not there holds no workflows. That is the usual case for most of them.
            continue;
        }
        for (const name of names) {
            const file = path.join(folder.dir, name);
            const parsed = readOne(file, name.slice(0, -".json".length));
            if ("reason" in parsed) failures.push({ file, reason: parsed.reason });
            else workflows.set(parsed.name, { workflow: parsed, file, source: folder.source });
        }
    }
    const left: Disabled[] = disabled.map((name) => {
        const found = workflows.get(name);
        workflows.delete(name);
        return found === undefined ? { name } : { name, file: found.file };
    });
    return { workflows, failures, disabled: left };
}

/** The lines `/workflow list` adds for `workflow.disabled`: what was left out, and a name that no file defines. */
export function disabledLines(loaded: Loaded): string[] {
    if (loaded.disabled.length === 0) return [];
    return [
        "",
        "Left out by workflow.disabled in jig.json:",
        ...loaded.disabled.map((entry) =>
            entry.file === undefined
                ? `  ${entry.name}: no workflow file has this name`
                : `  ${entry.name}: ${entry.file}`,
        ),
    ];
}

/** Whether `workflow.disabled` names this workflow, so that a message can say that and not "not found". */
export function turnedOff(loaded: Loaded, name: string): boolean {
    return loaded.disabled.some((entry) => entry.name === name);
}

/** The refusal for a ticket whose workflow is not available: turned off, or not loaded. */
export function missingWorkflow(loaded: Loaded, workflow: string, ticket: string): string {
    const why = turnedOff(loaded, workflow)
        ? "turned off by workflow.disabled in jig.json"
        : "not loaded: /workflow reload, or /workflow list for files that failed";
    return `the workflow ${workflow} of ${ticket} is ${why}`;
}

function readOne(file: string, stem: string): Workflow | { reason: string } {
    let text: string;
    try {
        if (!statSync(file).isFile()) return { reason: "not a file" };
        if (statSync(file).size > MAX_FILE_BYTES) return { reason: `larger than ${MAX_FILE_BYTES / 1024} KB` };
        text = readFileSync(file, "utf8");
    } catch (error) {
        return { reason: `cannot be read (${(error as Error).message.split("\n")[0]})` };
    }
    const parsed = parseWorkflow(text, stem);
    if (parsed.workflow === undefined || parsed.errors.length > 0) {
        const [first, ...more] = parsed.errors;
        return { reason: `${first ?? "not a workflow"}${more.length > 0 ? ` (and ${more.length} more)` : ""}` };
    }
    return parsed.workflow;
}

/** The workflows whose `match.ticket` matches a ticket key, by name. */
export function matching(loaded: Loaded, ticket: string): string[] {
    const names: string[] = [];
    for (const [name, { workflow }] of loaded.workflows) {
        if (workflow.match === undefined) continue;
        try {
            if (new RegExp(workflow.match).test(ticket)) names.push(name);
        } catch {
            // The pattern compiled when the file was read.
        }
    }
    return names.sort();
}
