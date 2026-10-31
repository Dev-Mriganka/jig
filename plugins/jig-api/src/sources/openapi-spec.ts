// An OpenAPI document as data: reading the file (JSON or YAML) and checking its version, following the `$ref`s that point inside it,
// and the small readers every other part uses (`textOf`, `originOf`). Also the two variables every environment gets. Kept apart
// from openapi.ts, which turns the document into a collection, so that the security and operation readers can use these without it.
import { isObject } from "../engine/values.ts";
import type { Problem } from "../model.ts";
import { readText, whyNotRead } from "./files.ts";
import type { Deref } from "./openapi-body.ts";
import { parseYaml } from "./yaml.ts";

const SPEC_MAX_BYTES = 8 * 1024 * 1024;

/** The variables every environment gets: the server it runs against. */
export const SERVER_URL = "serverUrl";
export const SERVER_ORIGIN = "serverOrigin";

/** Reads `$ref`s that point inside the document. A reference to another file or address is a problem, and is not followed. */
export function dereferencer(spec: Record<string, unknown>, report: (key: string, message: string) => void): Deref {
    const refused = new Set<string>();
    const follow = (node: unknown, depth: number): unknown => {
        if (!isObject(node) || typeof node.$ref !== "string") return node;
        const ref = node.$ref;
        if (!ref.startsWith("#/")) {
            if (!refused.has(ref)) {
                refused.add(ref);
                report(
                    ref.slice(0, 60),
                    "is a reference outside the document, which is not followed: put it in the document",
                );
            }
            return undefined;
        }
        if (depth > 20) return undefined;
        let current: unknown = spec;
        for (const part of ref.slice(2).split("/")) {
            const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
            current =
                isObject(current) || Array.isArray(current) ? (current as Record<string, unknown>)[key] : undefined;
            if (current === undefined) return undefined;
        }
        return follow(current, depth + 1);
    };
    return (node) => follow(node, 0);
}

export const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** The origin of a server address of the spec, with the defaults of its {variables} filled in; undefined for a relative one. */
export function originOf(server: unknown): string | undefined {
    if (!isObject(server) || typeof server.url !== "string") return undefined;
    const variables = isObject(server.variables) ? server.variables : {};
    const filled = server.url.replace(/\{([^}]+)\}/g, (match, name: string) => {
        const variable = variables[name];
        return isObject(variable) && typeof variable.default === "string" ? variable.default : match;
    });
    try {
        return new URL(filled).origin;
    } catch {
        return undefined;
    }
}

export function readSpec(file: string, shown: string, problems: Problem[]): Record<string, unknown> | undefined {
    let content: string;
    try {
        content = readText(file, SPEC_MAX_BYTES);
    } catch (error) {
        problems.push({ file: shown, key: "", message: whyNotRead(error), level: "error" });
        return undefined;
    }
    let raw: unknown;
    if (/\.json$/i.test(file) || content.trimStart().startsWith("{")) {
        try {
            raw = JSON.parse(content) as unknown;
        } catch {
            problems.push({ file: shown, key: "", message: "is not valid JSON", level: "error" });
            return undefined;
        }
    } else {
        raw = parseYaml(content, shown, problems);
        if (raw === undefined) return undefined;
    }
    if (!isObject(raw) || typeof raw.openapi !== "string") {
        const swagger = isObject(raw) && raw.swagger !== undefined;
        problems.push({
            file: shown,
            key: swagger ? "swagger" : "openapi",
            message: swagger
                ? "is a Swagger 2.0 document: only OpenAPI 3.0 and 3.1 are read"
                : "is missing: this is not an OpenAPI document",
            level: "error",
        });
        return undefined;
    }
    if (!/^3\.[01]\./.test(raw.openapi)) {
        problems.push({
            file: shown,
            key: "openapi",
            message: `is ${raw.openapi}: only OpenAPI 3.0 and 3.1 are read`,
            level: "error",
        });
        return undefined;
    }
    return raw;
}
