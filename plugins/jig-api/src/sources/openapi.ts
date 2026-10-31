// OpenAPI: a service's spec (3.0 or 3.1, as JSON or YAML) read as saved requests. A spec describes what an API can do, not what a
// team saves, so this source is opt-in and held tighter than the others:
//   - it runs only in the environments the configuration lists, and in production only for reads, and only when the
//     configuration says `allowProductionReads`;
//   - its hosts are the ones the configuration maps to each environment (`servers`), because a spec's own servers rarely match
//     a team's environment names. An environment with no server maps to no host, and nothing runs in it;
//   - every credential is a slot filled from `api.secrets` and nowhere else.
// Each operation with an `operationId` is a request named by it; the agent fills its parameters and the properties of a JSON body.
// Operations without an `operationId` are listed as `METHOD path` and refused.
// Format: https://spec.openapis.org/oas/v3.1.0 and https://spec.openapis.org/oas/v3.0.3
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../engine/values.ts";
import type { Collection, Environment, Problem, SavedRequest, Variable } from "../model.ts";
import { expandHome } from "./files.ts";
import type { Source } from "./source.ts";
import { requestOf } from "./openapi-operation.ts";
import type { Reading } from "./openapi-operation.ts";
import { chooseAuth, schemeOf } from "./openapi-security.ts";
import type { Scheme } from "./openapi-security.ts";
import { SERVER_ORIGIN, SERVER_URL, dereferencer, originOf, readSpec, textOf } from "./openapi-spec.ts";

export interface OpenApiConfig {
    file: string;
    /** The environment's name to the server it runs against. */
    servers: ReadonlyMap<string, string>;
    /** The environments the spec may run in, in the order given. */
    environments: readonly string[];
    allowProductionReads: boolean;
}

const MAX_ENVIRONMENTS = 20;
const NAME = /^[^\u0000-\u001f\u007f]{1,60}$/;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

// ---------------------------------------------------------------------------------------------------------------------
// Configuration

/** A server address: https (or http, which the engine then allows only for this machine), with no user, query or variables. */
function checkServer(value: unknown, key: string, errors: string[]): string | undefined {
    if (typeof value !== "string" || value.trim() === "" || value.length > 500) {
        errors.push(`${key}: must be the address of a server, such as https://api.staging.example.com/v1`);
        return undefined;
    }
    if (/[{}]/.test(value)) {
        errors.push(`${key}: must be one address with no {variables}: a host is not filled in from a call`);
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        errors.push(`${key}: must be the address of a server, such as https://api.staging.example.com/v1`);
        return undefined;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        errors.push(
            `${key}: must start with https:// (plain http is only for this machine, and needs allowPlainLocal)`,
        );
    } else if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
        errors.push(`${key}: must be a host and a base path only, with no user, query or fragment`);
    } else {
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }
    return undefined;
}

function check(entry: Readonly<Record<string, unknown>>, at: string, errors: string[]): OpenApiConfig | undefined {
    const before = errors.length;
    for (const key of Object.keys(entry)) {
        if (!["openapi", "servers", "environments", "allowProductionReads"].includes(key))
            errors.push(`${at}.${key}: unknown field`);
    }

    let file: string | undefined;
    const given = entry.openapi;
    if (typeof given !== "string" || given.trim() === "" || given.length > 1000 || given.includes("\0")) {
        errors.push(`${at}.openapi: must be the path of an OpenAPI file, JSON or YAML`);
    } else if (!path.isAbsolute(expandHome(given.trim()))) {
        errors.push(`${at}.openapi: must be an absolute path or start with ~/`);
    } else {
        file = path.normalize(expandHome(given.trim()));
    }

    const environments: string[] = [];
    if (!Array.isArray(entry.environments) || entry.environments.length === 0) {
        errors.push(`${at}.environments: required, the list of environments this spec may run in, such as ["Staging"]`);
    } else if (entry.environments.length > MAX_ENVIRONMENTS) {
        errors.push(`${at}.environments: at most ${MAX_ENVIRONMENTS} environments`);
    } else {
        for (const item of entry.environments as unknown[]) {
            if (typeof item !== "string" || !NAME.test(item)) {
                errors.push(
                    `${at}.environments: an environment name is text of 1 to 60 characters with no control characters`,
                );
            } else if (environments.includes(item))
                errors.push(`${at}.environments: ${JSON.stringify(item)} is listed twice`);
            else environments.push(item);
        }
    }

    const servers = new Map<string, string>();
    if (entry.servers !== undefined) {
        if (!isObject(entry.servers)) {
            errors.push(`${at}.servers: must be an object that maps an environment name to the address of its server`);
        } else {
            for (const [name, value] of Object.entries(entry.servers)) {
                if (!environments.includes(name)) {
                    errors.push(`${at}.servers.${name}: is not in environments, so the spec never runs there`);
                    continue;
                }
                const server = checkServer(value, `${at}.servers.${name}`, errors);
                if (server !== undefined) servers.set(name, server);
            }
        }
    }

    let allowProductionReads = false;
    if (typeof entry.allowProductionReads === "boolean") allowProductionReads = entry.allowProductionReads;
    else if (entry.allowProductionReads !== undefined) errors.push(`${at}.allowProductionReads: must be true or false`);

    if (errors.length > before || file === undefined) return undefined;
    return { file, servers, environments, allowProductionReads };
}

function load(config: OpenApiConfig, name: string): Collection {
    const problems: Problem[] = [];
    const shown = path.basename(config.file);
    const root = path.dirname(config.file);
    const empty = (): Collection => ({
        name,
        root,
        requests: [],
        environments: new Map(),
        variables: new Map(),
        auth: { kind: "none" },
        productionReads: config.allowProductionReads,
        problems,
    });
    if (!fs.existsSync(config.file)) {
        problems.push({ file: shown, key: "", message: "no such file", level: "error" });
        return empty();
    }
    const spec = readSpec(config.file, shown, problems);
    if (spec === undefined) return empty();

    const deref = dereferencer(spec, (ref, message) =>
        problems.push({ file: shown, key: ref, message, level: "warning" }),
    );
    const declared = Array.isArray(spec.servers) ? (spec.servers as unknown[]) : [];
    const serverOrigins = new Set(declared.map(originOf).filter((origin): origin is string => origin !== undefined));
    const components = isObject(spec.components) ? spec.components : {};
    const schemes = new Map<string, Scheme>();
    if (isObject(components.securitySchemes)) {
        for (const [scheme, raw] of Object.entries(components.securitySchemes))
            schemes.set(scheme, schemeOf(scheme, deref(raw), serverOrigins));
    }

    const reading: Reading = {
        collection: name,
        shown,
        problems,
        deref,
        schemes,
        rootSecurity: spec.security,
        slots: new Set(),
    };
    const requests: SavedRequest[] = [];
    const seen = new Set<string>();
    if (isObject(spec.paths)) {
        for (const [pathName, rawItem] of Object.entries(spec.paths)) {
            const pathItem = deref(rawItem);
            if (!isObject(pathItem)) continue;
            const methods = Object.keys(pathItem).filter((each): each is (typeof METHODS)[number] =>
                (METHODS as readonly string[]).includes(each),
            );
            for (const method of methods) {
                const operation = deref(pathItem[method]);
                if (!isObject(operation)) continue;
                const request = requestOf(pathName, method, pathItem, operation, reading);
                // An operationId is unique in a spec; a second one with the same name could not be told apart.
                if (seen.has(request.name) && textOf(operation.operationId).trim() !== "") {
                    const message = `${request.name} is used again: the later operation is refused`;
                    problems.push({
                        file: shown,
                        key: `paths.${pathName}.${method}.operationId`,
                        message,
                        level: "warning",
                    });
                    const again = `its operationId ${request.name} is used by another operation too`;
                    requests.push({ ...request, unsupported: request.unsupported ?? again });
                } else {
                    requests.push(request);
                }
                seen.add(request.name);
            }
        }
    }

    // The collection's own sign-in, for an ad-hoc call: the spec's security.
    const top = chooseAuth(spec.security, schemes);
    for (const slot of top.slots) reading.slots.add(slot);

    // The environments: only those the configuration lists. Each is the server it maps to, and the credential slots, which are
    // declared secret so that they come from api.secrets and nowhere else.
    const environments = new Map<string, Environment>();
    for (const label of config.environments) {
        const server = config.servers.get(label);
        const variables = new Map<string, Variable>();
        variables.set(SERVER_URL, { value: server ?? "", secret: false });
        variables.set(SERVER_ORIGIN, { value: server === undefined ? "" : new URL(server).origin, secret: false });
        for (const slot of reading.slots) variables.set(slot, { value: "", secret: true });
        environments.set(label, {
            name: label,
            file: shown,
            variables,
            ...(server === undefined
                ? {
                      unavailable: `no server is mapped to it: add ${JSON.stringify(label)} to servers in the configuration of ${name}`,
                  }
                : {}),
        });
    }

    return {
        name,
        root,
        requests,
        environments,
        variables: new Map(),
        auth: top.auth,
        ...(top.unsupported === undefined ? {} : { authRefused: top.unsupported }),
        productionReads: config.allowProductionReads,
        problems,
    };
}

export const openapi: Source<OpenApiConfig> = { kind: "openapi", check, load };
