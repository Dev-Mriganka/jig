// Bruno: a collection kept as a folder in git, in either of Bruno's formats. A folder with `opencollection.yml` is OpenCollection
// YAML (Bruno's default since v3.1); a folder with `bruno.json` is the `.bru` language. The language readers are bruno-yaml.ts
// and bruno-bru.ts, and both give the shapes of bruno-types.ts; this file walks the folder and turns them into saved requests.
//
// What is read: folders and requests (HTTP and GraphQL), the address with its path parameters, headers, the body (JSON, text,
// XML, URL-encoded form, multipart form with files, a file, GraphQL), the sign-in (bearer, basic, an API key in a header, OAuth 2.0
// with client credentials or a password), and what the collection and each folder set for everything below them: headers, a
// sign-in, variables. Environments come from `environments/`.
// What is never done: a script is not run. A request that a pre-request script applies to (its own, its folder's or the
// collection's) is refused by name; post-response scripts and tests are ignored with a note. `assert` blocks are read and shown,
// and not run. No `.env` file is read: `{{process.env.NAME}}` is a secret, and comes from `api.secrets` and from nowhere else.
// Formats: https://docs.usebruno.com/bru-lang/language and https://github.com/opencollection-dev/opencollection
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../engine/values.ts";
import { declaredSecrets } from "../model.ts";
import type { Collection, Problem, SavedRequest, Variable } from "../model.ts";
import { variablesIn } from "../template.ts";
import * as opencollection from "./bruno-yaml.ts";
import { expandHome } from "./files.ts";
import type { Source } from "./source.ts";
import { parseYaml } from "./yaml.ts";
import { environmentsOf } from "./bruno-environments.ts";
import { PROCESS_ENV, formatOf, reporter, textOf } from "./bruno-reading.ts";
import type { Reading } from "./bruno-reading.ts";
import { belowCollection } from "./bruno-request.ts";
import { EMPTY_DEFAULTS, build, entriesOfDirectory, entriesOfItems, readDefaultsFile } from "./bruno-tree.ts";

export interface BrunoConfig {
    folder: string;
}

function check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): BrunoConfig | undefined {
    const before = errors.length;
    for (const key of Object.keys(entry)) if (key !== "bruno") errors.push(`${at}.${key}: unknown field`);
    const value = entry.bruno;
    let folder: string | undefined;
    if (typeof value !== "string" || value.trim() === "" || value.length > 1000 || value.includes("\0")) {
        errors.push(`${at}.bruno: must be the path of a Bruno collection folder`);
    } else if (!path.isAbsolute(expandHome(value.trim()))) {
        errors.push(`${at}.bruno: must be an absolute path or start with ~/`);
    } else {
        folder = path.normalize(expandHome(value.trim()));
    }
    return errors.length > before || folder === undefined ? undefined : { folder };
}

const namesIn = (list: unknown): Set<string> =>
    new Set(Array.isArray(list) ? (list as unknown[]).filter((item): item is string => typeof item === "string") : []);

function ignoredBy(root: string, problems: Problem[]): Set<string> {
    const file = path.join(root, "bruno.json");
    if (!fs.existsSync(file)) return new Set();
    const content = textOf(file, "bruno.json", problems);
    if (content === undefined) return new Set();
    try {
        const raw = JSON.parse(content) as unknown;
        return isObject(raw) ? namesIn(raw.ignore) : new Set();
    } catch {
        problems.push({ file: "bruno.json", key: "", message: "is not valid JSON", level: "error" });
        return new Set();
    }
}

export function load(config: BrunoConfig, name: string): Collection {
    const problems: Problem[] = [];
    const root = config.folder;
    const empty = (): Collection => ({
        name,
        root,
        requests: [],
        environments: new Map(),
        variables: new Map(),
        auth: { kind: "none" },
        problems,
    });
    if (!fs.existsSync(root)) {
        problems.push({ file: ".", key: "", message: "the folder does not exist", level: "error" });
        return empty();
    }
    const format = formatOf(root);
    if (format === undefined) {
        problems.push({
            file: ".",
            key: "",
            message: "is not a Bruno collection: it has neither opencollection.yml nor bruno.json",
            level: "error",
        });
        return empty();
    }
    const reading: Reading = {
        collection: name,
        root,
        format,
        problems,
        secretNames: new Set(),
        ignored: new Set(),
        files: 0,
        processEnv: new Set(),
        values: [],
    };

    // Environments first: which variables are secret decides how the requests are read.
    const environments = environmentsOf(reading);

    // The collection's own settings, and its bundled items if the file holds any.
    let defaults = EMPTY_DEFAULTS;
    let bundled: unknown;
    if (format === "yaml") {
        const content = textOf(path.join(root, "opencollection.yml"), "opencollection.yml", problems);
        const raw = content === undefined ? undefined : parseYaml(content, "opencollection.yml", problems);
        if (raw !== undefined) {
            defaults = opencollection.readDefaults(raw, reporter(problems, "opencollection.yml"));
            if (isObject(raw)) {
                bundled = raw.items;
                const extensions =
                    isObject(raw.extensions) && isObject(raw.extensions.bruno) ? raw.extensions.bruno : {};
                reading.ignored = namesIn(extensions.ignore);
                const inline = isObject(raw.config) ? raw.config.environments : undefined;
                if (Array.isArray(inline) && inline.length > 0) {
                    problems.push({
                        file: "opencollection.yml",
                        key: "config.environments",
                        message: "environments inside the collection file are not read: keep them in environments/",
                        level: "warning",
                    });
                }
            }
        }
    } else {
        reading.ignored = ignoredBy(root, problems);
        defaults = readDefaultsFile(path.join(root, "collection.bru"), "collection.bru", reading) ?? EMPTY_DEFAULTS;
    }

    reading.secretNames = declaredSecrets(environments.values());
    const top = belowCollection(defaults);
    const requests: SavedRequest[] = [];
    build(
        [...entriesOfDirectory(root, 0, reading), ...entriesOfItems(bundled, "items", reading)],
        top,
        reading,
        requests,
    );

    // The collection's variables are the weakest values.
    const variables = new Map<string, Variable>();
    for (const [key, value] of defaults.vars) {
        reading.values.push(value);
        variables.set(key, { value, secret: false });
    }

    // `{{process.env.NAME}}` anywhere, even inside the value of another variable, is a secret in every environment.
    for (const value of reading.values) {
        for (const variable of variablesIn(value))
            if (variable.startsWith(PROCESS_ENV)) reading.processEnv.add(variable);
    }
    for (const environment of environments.values()) {
        const declared = environment.variables as Map<string, Variable>;
        for (const variable of reading.processEnv) declared.set(variable, { value: "", secret: true });
    }

    const refused = top.auth.kind === "refused" ? top.auth.reason : undefined;
    return {
        name,
        root,
        requests,
        environments,
        variables,
        auth: top.auth.kind === "set" ? top.auth.auth : { kind: "none" },
        ...(refused === undefined ? {} : { authRefused: refused }),
        problems,
    };
}

export const bruno: Source<BrunoConfig> = { kind: "bruno", check, load };
