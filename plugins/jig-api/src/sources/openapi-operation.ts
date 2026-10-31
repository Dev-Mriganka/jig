// One operation of an OpenAPI spec read as a saved request: its parameters and which of them the agent may give, its JSON body, its
// address on the environment's server, its sign-in, and the reasons it is refused. It is the longest part of reading a spec, so it has a
// file of its own; openapi.ts calls `requestOf` once for each operation it finds.
import { isObject } from "../engine/values.ts";
import { CREDENTIAL_HEADERS } from "../model.ts";
import type { Body, Problem, SavedRequest } from "../model.ts";
import { unsupportedVariable, variablesIn } from "../template.ts";
import { describeScalar, shapeOf, templateOf, whyNotScalar } from "./openapi-body.ts";
import type { Deref, Leaf } from "./openapi-body.ts";
import { authTexts } from "./texts.ts";
import { chooseAuth } from "./openapi-security.ts";
import type { Scheme } from "./openapi-security.ts";
import { SERVER_ORIGIN, SERVER_URL, textOf } from "./openapi-spec.ts";

const SENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
/** Headers the specification says a parameter cannot define: the transport and the sign-in set them. */
const IGNORED_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "authorization"]);
/** Names of headers that carry a credential, besides those every source treats so. */
const CREDENTIAL_NAME = /api[-_]?key|token|secret|passw|credential|session|signature/i;

type Location = "path" | "query" | "header" | "cookie";

interface Parameter {
    name: string;
    in: Location;
    required: boolean;
    schema: Record<string, unknown>;
    description: string;
}

/** The parameters of an operation: those of its path item, then its own, which replace a path item's of the same name and place. */
function parametersOf(
    pathItem: Record<string, unknown>,
    operation: Record<string, unknown>,
    deref: Deref,
    report: (key: string, message: string) => void,
): Parameter[] {
    const found = new Map<string, Parameter>();
    for (const [from, list] of [
        ["path item", pathItem.parameters],
        ["operation", operation.parameters],
    ] as const) {
        if (!Array.isArray(list)) continue;
        (list as unknown[]).forEach((raw, index) => {
            const parameter = deref(raw);
            // A name with braces or control characters could not stand in a `{{variable}}`.
            if (
                !isObject(parameter) ||
                typeof parameter.name !== "string" ||
                parameter.name === "" ||
                /[{}\u0000-\u001f]/.test(parameter.name)
            ) {
                report(`${from} parameters[${index}]`, "has no name that can be a variable, and is left out");
                return;
            }
            const place = parameter.in;
            if (place !== "path" && place !== "query" && place !== "header" && place !== "cookie") {
                const message = `is "in" ${JSON.stringify(place)}, which is not path, query, header or cookie, and is left out`;
                report(`${from} parameters[${index}]`, message);
                return;
            }
            // A parameter may describe its value with `content` and not `schema`: the schema of its first media type.
            const content = isObject(parameter.content) ? Object.values(parameter.content)[0] : undefined;
            const given = deref(parameter.schema ?? (isObject(content) ? content.schema : undefined));
            found.set(`${place}:${place === "header" ? parameter.name.toLowerCase() : parameter.name}`, {
                name: parameter.name,
                in: place,
                required: place === "path" || parameter.required === true,
                schema: isObject(given) ? given : {},
                description: textOf(parameter.description).replace(/\s+/g, " ").trim(),
            });
        });
    }
    return [...found.values()];
}

/** Query names keep their brackets (`filter[status]`), which servers read as written. */
const queryName = (name: string): string => encodeURIComponent(name).replace(/%5B/gi, "[").replace(/%5D/gi, "]");

/** What a source needs to know about the spec while it reads each operation. */
export interface Reading {
    collection: string;
    shown: string;
    problems: Problem[];
    deref: Deref;
    schemes: ReadonlyMap<string, Scheme>;
    rootSecurity: unknown;
    slots: Set<string>;
}

interface Part {
    kind: "path" | "query" | "header" | "body";
    name: string;
    required: boolean;
    doc: string;
    leaf?: Leaf;
}

export function requestOf(
    pathName: string,
    method: string,
    pathItem: Record<string, unknown>,
    operation: Record<string, unknown>,
    reading: Reading,
): SavedRequest {
    const { deref } = reading;
    const key = `paths.${pathName}.${method}`;
    const report = (inner: string, message: string): void =>
        void reading.problems.push({ file: reading.shown, key: `${key}.${inner}`, message, level: "warning" });
    const id = textOf(operation.operationId).trim();
    const upper = method.toUpperCase();
    const notes: string[] = [];
    let unsupported: string | undefined;
    if (id === "") {
        unsupported = "it has no operationId, so it has no name to run it by: add one to the spec";
        notes.push("it has no operationId, so it is named by its method and path");
    }
    if (operation.deprecated === true) notes.push("the spec marks it deprecated");
    if (Array.isArray(operation.servers) && operation.servers.length > 0) {
        unsupported ??=
            "it has servers of its own, and a host comes only from the servers the configuration maps to the environment";
    }
    if (!SENT_METHODS.has(upper))
        unsupported ??= `the method ${upper} is not sent (GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE are)`;

    // The sign-in: the operation's own security, else the spec's.
    const chosen = chooseAuth(operation.security ?? reading.rootSecurity, reading.schemes);
    if (chosen.unsupported !== undefined) unsupported ??= chosen.unsupported;
    for (const slot of chosen.slots) reading.slots.add(slot);
    const signedHeader = chosen.auth.kind === "apiKey" ? chosen.auth.name.toLowerCase() : undefined;

    // The parts that become variables: parameters first, then the properties of a JSON body.
    const parts: Part[] = [];
    const parameters = parametersOf(pathItem, operation, deref, report);
    const used: Array<{ parameter: Parameter; part: Part }> = [];
    for (const parameter of parameters) {
        const lower = parameter.name.toLowerCase();
        if (
            parameter.in === "header" &&
            (IGNORED_HEADERS.has(lower) || CREDENTIAL_HEADERS.has(lower) || CREDENTIAL_NAME.test(parameter.name))
        ) {
            // A credential is never a value the agent gives: it comes from a security scheme. The specification itself says that a
            // parameter named Accept, Content-Type or Authorization is ignored, and the key the sign-in sends is the sign-in's.
            if (parameter.required && !IGNORED_HEADERS.has(lower) && lower !== signedHeader) {
                unsupported ??=
                    `it needs the header ${parameter.name}, which carries a credential: ` +
                    "declare it as a security scheme so that it comes from api.secrets";
            } else {
                notes.push(
                    `the header parameter ${parameter.name} is ignored: a credential or a header the tool sets comes from the sign-in`,
                );
            }
            continue;
        }
        if (parameter.in === "cookie") {
            if (parameter.required) unsupported ??= `it needs the cookie ${parameter.name}, and no cookies are sent`;
            else notes.push(`the optional cookie ${parameter.name} is left out: no cookies are sent`);
            continue;
        }
        const why = whyNotScalar(parameter.schema);
        if (why !== undefined) {
            const what = `the ${parameter.in} parameter ${parameter.name}`;
            if (parameter.required)
                unsupported ??= `it needs ${what}, which is ${why} and cannot be filled from a variable`;
            else
                notes.push(
                    `the optional ${what.replace(/^the /, "")} is left out: it is ${why}, and cannot be filled from a variable`,
                );
            continue;
        }
        const docs = [describeScalar(parameter.schema), parameter.description].filter((part) => part !== "").join("; ");
        const part: Part = {
            kind: parameter.in,
            name: parameter.name,
            required: parameter.required,
            doc: `${parameter.in} parameter, ${docs}`,
        };
        parts.push(part);
        used.push({ parameter, part });
    }

    // The body: JSON only, filled property by property.
    let bodyShape: ReturnType<typeof shapeOf> | undefined;
    const requestBody = deref(operation.requestBody);
    if (isObject(requestBody) && isObject(requestBody.content)) {
        const wanted = requestBody.required === true;
        const types = Object.keys(requestBody.content);
        const json = types.find((type) => /^application\/(?:[\w.+-]+\+)?json(?:\s*;.*)?$/i.test(type));
        if (json === undefined) {
            const named = types.join(", ") || "none";
            if (wanted) unsupported ??= `its request body is ${named}, and only JSON bodies are filled from a spec`;
            else
                notes.push(`its optional request body (${named}) is left out: only JSON bodies are filled from a spec`);
        } else {
            const media = (requestBody.content as Record<string, unknown>)[json];
            bodyShape = shapeOf(isObject(media) ? media.schema : undefined, deref, wanted);
            notes.push(...bodyShape.notes);
            if (bodyShape.unsupported !== undefined) unsupported ??= bodyShape.unsupported;
            for (const leaf of bodyShape.leaves) {
                parts.push({ kind: "body", name: leaf.path.join("."), required: leaf.required, doc: leaf.doc, leaf });
            }
        }
    }

    // Names: a part is named by its own name; when two share one (or it is one the environment sets), each is named by its place too.
    const counts = new Map<string, number>();
    for (const part of parts) counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
    const reserved = new Set([SERVER_URL, SERVER_ORIGIN]);
    const nameOf = (part: Part): string =>
        (counts.get(part.name) ?? 0) > 1 || reserved.has(part.name) ? `${part.kind}.${part.name}` : part.name;

    // The address: the server, the path with its parameters, and the query parameters.
    let route = pathName.startsWith("/") ? pathName : `/${pathName}`;
    for (const placeholder of [...pathName.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string)) {
        const found = used.find(({ parameter }) => parameter.in === "path" && parameter.name === placeholder);
        if (found === undefined) {
            unsupported ??= `its path has {${placeholder}}, which no path parameter describes`;
            continue;
        }
        route = route.replace(`{${placeholder}}`, () => `{{${nameOf(found.part)}}}`);
    }
    let url = `{{${SERVER_URL}}}${route}`;
    const query = used
        .filter(({ parameter }) => parameter.in === "query")
        .map(({ parameter, part }) => `${queryName(parameter.name)}={{${nameOf(part)}}}`);
    if (query.length > 0) url += `?${query.join("&")}`;

    const headers: Array<readonly [string, string]> = used
        .filter(({ parameter }) => parameter.in === "header")
        .map(({ parameter, part }) => [parameter.name, `{{${nameOf(part)}}}`]);
    let body: Body | undefined;
    if (bodyShape?.root !== undefined) {
        const names = new Map(
            parts.filter((part) => part.leaf !== undefined).map((part) => [part.leaf as Leaf, nameOf(part)]),
        );
        body = { kind: "json", text: templateOf(bodyShape.root, (leaf) => names.get(leaf) as string) };
        headers.push(["Content-Type", "application/json"]);
    }

    const bodyText = body?.kind === "json" ? body.text : undefined;
    const variables = variablesIn(url, ...headers.map(([, value]) => value), bodyText, ...authTexts(chosen.auth));
    unsupported ??= unsupportedVariable(variables);
    const signsIn = variablesIn(...authTexts(chosen.auth));
    const description = [textOf(operation.summary).trim(), textOf(operation.description).trim()]
        .filter((part) => part !== "")
        .join("\n\n");
    const tag = Array.isArray(operation.tags)
        ? operation.tags.find((item): item is string => typeof item === "string" && item !== "")
        : undefined;

    return {
        collection: reading.collection,
        folder: tag === undefined ? [] : [tag],
        name: id === "" ? `${upper} ${pathName}` : id,
        origin: `${reading.shown}: ${upper} ${pathName}`,
        method: upper,
        url,
        headers,
        ...(body === undefined ? {} : { body }),
        auth: chosen.auth,
        variables,
        secrets: variables.filter((variable) => chosen.slots.includes(variable)),
        signsIn,
        defaults: new Map(),
        optional: parts.filter((part) => !part.required).map(nameOf),
        variableDocs: new Map(parts.map((part) => [nameOf(part), part.doc])),
        scripts: { prerequest: false },
        ...(unsupported === undefined ? {} : { unsupported }),
        notes,
        ...(description === "" ? {} : { description }),
    };
}
