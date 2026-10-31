// The environments of a Bruno collection (`environments/`): each file read in the collection's language, the `extends` chain merged,
// and every secret turned into a name with no value, because a secret is never read from a file.
import fs from "node:fs";
import path from "node:path";
import type { Environment, Problem, Variable } from "../model.ts";
import * as bru from "./bruno-bru.ts";
import * as opencollection from "./bruno-yaml.ts";
import type { ParsedEnvironment, ParsedVariable } from "./bruno-types.ts";
import { readFailure } from "./files.ts";
import { parseYaml } from "./yaml.ts";
import { extensionOf, reporter, textOf } from "./bruno-reading.ts";
import type { Reading } from "./bruno-reading.ts";

interface EnvironmentFile {
    name: string;
    file: string;
    parsed: ParsedEnvironment;
}

function readEnvironmentFiles(reading: Reading): EnvironmentFile[] {
    const { root, format, problems } = reading;
    const directory = path.join(root, "environments");
    if (!fs.existsSync(directory)) return [];
    let names: string[];
    try {
        names = fs.readdirSync(directory).sort();
    } catch (error) {
        problems.push({ file: "environments", key: "", message: readFailure(error), level: "error" });
        return [];
    }
    const found: EnvironmentFile[] = [];
    for (const entry of names) {
        const extension = extensionOf(format).find((each) => entry.endsWith(each));
        if (extension === undefined || entry.startsWith(".")) continue;
        const relative = `environments/${entry}`;
        const file = path.join(directory, entry);
        if (fs.lstatSync(file).isSymbolicLink()) {
            problems.push({ file: relative, key: "", message: "is a link, and links are not read", level: "warning" });
            continue;
        }
        const content = textOf(file, relative, problems);
        if (content === undefined) continue;
        const report = reporter(problems, relative);
        let parsed: ParsedEnvironment | undefined;
        if (format === "bru") {
            parsed = bru.readEnvironment(content, report);
        } else {
            const raw = parseYaml(content, relative, problems);
            if (raw !== undefined) parsed = opencollection.readEnvironment(raw, report);
        }
        if (parsed === undefined) continue;
        const name = parsed.name ?? entry.slice(0, entry.length - extension.length);
        if (found.some((each) => each.name === name)) {
            problems.push({
                file: relative,
                key: "",
                message: `names the environment ${name} again; the later file wins`,
                level: "warning",
            });
        }
        found.push({ name, file: relative, parsed });
    }
    return found;
}

/** A variable of an environment after its `extends` chain: a name is secret if any file says so. */
interface Merged {
    secret: boolean;
    /** The last value written for it. For a secret that is a value someone typed in a file, which is refused. */
    value: string | undefined;
    external: string | undefined;
}

/** The variables of an environment: those of the environments it extends first, then its own. */
function mergedVariables(
    start: EnvironmentFile,
    all: readonly EnvironmentFile[],
    problems: Problem[],
    seen: readonly string[] = [],
): Map<string, Merged> {
    const merged = new Map<string, Merged>();
    const add = (variable: ParsedVariable): void => {
        const before = merged.get(variable.name);
        const written = variable.value !== undefined && variable.value !== "" ? variable.value : undefined;
        merged.set(variable.name, {
            secret: variable.secret || before?.secret === true,
            value: variable.secret ? (written ?? before?.value) : (variable.value ?? ""),
            external: variable.external ?? before?.external,
        });
    };
    for (const parent of start.parsed.extends) {
        const found = all.find((each) => each.name === parent);
        if (found === undefined) {
            problems.push({
                file: start.file,
                key: "extends",
                message: `names the environment ${parent}, which does not exist`,
                level: "warning",
            });
        } else if (seen.includes(found.name) || found.name === start.name) {
            problems.push({
                file: start.file,
                key: "extends",
                message: `extends ${parent}, which extends it back`,
                level: "warning",
            });
        } else {
            for (const [name, variable] of mergedVariables(found, all, problems, [...seen, start.name])) {
                const before = merged.get(name);
                merged.set(name, { ...variable, secret: variable.secret || before?.secret === true });
            }
        }
    }
    for (const variable of start.parsed.variables) add(variable);
    return merged;
}

export function environmentsOf(reading: Reading): Map<string, Environment> {
    const { problems } = reading;
    const files = readEnvironmentFiles(reading);
    const environments = new Map<string, Environment>();
    for (const file of files) {
        if (file.parsed.dotEnv) {
            problems.push({
                file: file.file,
                key: "dotEnvFilePath",
                message:
                    "points at a .env file, which is never read: give those values in api.secrets as process.env.NAME",
                level: "warning",
            });
        }
        const variables = new Map<string, Variable>();
        for (const [name, merged] of mergedVariables(file, files, problems)) {
            if (merged.secret) {
                // A secret is never read from a file. A value written for it is not used, and a warning says where it is.
                if (merged.value !== undefined && merged.value !== "") {
                    problems.push({
                        file: file.file,
                        key: name,
                        message:
                            `is a secret with a value in the file. The value is ignored and never sent; ` +
                            `give the secret in api.secrets as "${name}"`,
                        level: "warning",
                    });
                }
                if (merged.external !== undefined) {
                    problems.push({
                        file: file.file,
                        key: name,
                        message: `comes from ${merged.external}, which is not read: give the secret in api.secrets as "${name}"`,
                        level: "warning",
                    });
                }
                variables.set(name, { value: "", secret: true });
            } else {
                const value = merged.value ?? "";
                reading.values.push(value);
                variables.set(name, { value, secret: false });
            }
        }
        environments.set(file.name, { name: file.name, file: file.file, variables });
    }
    return environments;
}
