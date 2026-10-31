// The `workflow` section of jig.json: where to read workflow files from, and the test command of each repository. jig-core
// checks the section with `validateWorkflow` when it loads, so the rest of the plugin reads a section that is valid, or absent.
import os from "node:os";
import path from "node:path";

export interface TestRule {
    /** A repository name or a path pattern. */
    key: string;
    command: string;
    timeoutSeconds?: number;
}

export interface WorkflowSettings {
    /** Absolute folders. */
    folders: string[];
    /** In the order they are written: the first that matches a repository is used. */
    tests: TestRule[];
    testTimeoutSeconds: number;
}

export const DEFAULT_TEST_TIMEOUT_SECONDS = 900;
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 7200;

/** The fields of the section, in the order the README's table lists them. */
export const SECTION_FIELDS: readonly string[] = ["folders", "tests", "testTimeoutSeconds"];
const FIELDS: ReadonlySet<string> = new Set(SECTION_FIELDS);
const TEST_FIELDS: ReadonlySet<string> = new Set(["command", "timeoutSeconds"]);
const MAX_COMMAND = 1000;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeout(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= MIN_TIMEOUT_SECONDS &&
        value <= MAX_TIMEOUT_SECONDS
    );
}

/** A test command is one line of text. A shell is started for it, so its words are the user's own. */
function isCommand(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.trim() !== "" &&
        value.length <= MAX_COMMAND &&
        !/[\u0000-\u001f\u007f]/.test(value)
    );
}

/** The errors in a raw `workflow` section, each naming its key. An empty list means the section is valid. */
export function validateWorkflow(raw: unknown): string[] {
    if (!isObject(raw)) return ["workflow: must be an object"];
    const errors = Object.keys(raw)
        .filter((name) => !FIELDS.has(name))
        .map((name) => `workflow.${name}: unknown field`);
    const { folders, tests, testTimeoutSeconds } = raw;
    if (folders !== undefined) {
        if (!Array.isArray(folders)) {
            errors.push("workflow.folders: must be a list of folders");
        } else {
            folders.forEach((folder, index) => {
                if (typeof folder !== "string" || (!path.isAbsolute(folder) && !folder.startsWith("~/"))) {
                    errors.push(`workflow.folders[${index}]: use an absolute path, or one that starts with ~/`);
                }
            });
        }
    }
    if (tests !== undefined) {
        if (!isObject(tests)) {
            errors.push("workflow.tests: must be an object from a repository name or path pattern to a command");
        } else {
            for (const [key, value] of Object.entries(tests)) {
                const at = `workflow.tests.${key}`;
                if (key === "" || key.length > 200) errors.push(`workflow.tests: a key must be 1 to 200 characters`);
                if (isObject(value)) {
                    for (const field of Object.keys(value)) {
                        if (!TEST_FIELDS.has(field)) errors.push(`${at}.${field}: unknown field`);
                    }
                    if (!isCommand(value.command)) errors.push(`${at}.command: must be one line of text`);
                    if (value.timeoutSeconds !== undefined && !isTimeout(value.timeoutSeconds)) {
                        errors.push(
                            `${at}.timeoutSeconds: must be a whole number from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`,
                        );
                    }
                } else if (!isCommand(value)) {
                    errors.push(`${at}: must be a command, or { "command": "...", "timeoutSeconds": 300 }`);
                }
            }
        }
    }
    if (testTimeoutSeconds !== undefined && !isTimeout(testTimeoutSeconds)) {
        errors.push(
            `workflow.testTimeoutSeconds: must be a whole number from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`,
        );
    }
    return errors;
}

/** The section with defaults filled in. An absent or invalid section gives the defaults. */
export function settingsFrom(section: unknown, home: string = os.homedir()): WorkflowSettings {
    const settings: WorkflowSettings = { folders: [], tests: [], testTimeoutSeconds: DEFAULT_TEST_TIMEOUT_SECONDS };
    if (!isObject(section) || validateWorkflow(section).length > 0) return settings;
    if (Array.isArray(section.folders)) {
        settings.folders = (section.folders as string[]).map((folder) =>
            folder.startsWith("~/") ? path.join(home, folder.slice(2)) : folder,
        );
    }
    if (isObject(section.tests)) {
        for (const [key, value] of Object.entries(section.tests)) {
            if (typeof value === "string") settings.tests.push({ key, command: value });
            else if (isObject(value)) {
                settings.tests.push({
                    key,
                    command: value.command as string,
                    ...(value.timeoutSeconds === undefined ? {} : { timeoutSeconds: value.timeoutSeconds as number }),
                });
            }
        }
    }
    if (typeof section.testTimeoutSeconds === "number") settings.testTimeoutSeconds = section.testTimeoutSeconds;
    return settings;
}
