// A Postman request body (raw, URL-encoded form, multipart form, a file, GraphQL) read as a `Body`, with the content type Postman
// would send for it and a note for anything left out. A body type this plugin cannot send is refused with the reason.
import { isObject } from "../engine/values.ts";
import type { Body, FormField } from "../model.ts";
import { text } from "./postman-values.ts";

const LANGUAGE_TYPES: Readonly<Record<string, string>> = {
    json: "application/json",
    xml: "application/xml",
    html: "text/html",
    text: "text/plain",
    javascript: "application/javascript",
};

interface BodyResult {
    body?: Body;
    /** The content type Postman sends for the body when the request sets none. */
    contentType?: string;
    unsupported?: string;
    notes: string[];
}

export function bodyOf(raw: unknown): BodyResult {
    const notes: string[] = [];
    if (!isObject(raw) || raw.disabled === true || typeof raw.mode !== "string") return { notes };
    switch (raw.mode) {
        case "raw": {
            const content = typeof raw.raw === "string" ? raw.raw : "";
            if (content === "") return { notes };
            const options = isObject(raw.options) && isObject(raw.options.raw) ? raw.options.raw : {};
            const language = typeof options.language === "string" ? options.language : "text";
            const contentType = LANGUAGE_TYPES[language] ?? "text/plain";
            if (language === "json") return { body: { kind: "json", text: content }, contentType, notes };
            const markup = language === "xml" || language === "html" ? language : "text";
            return { body: { kind: "raw", text: content, language: markup }, contentType, notes };
        }
        case "urlencoded": {
            const fields: FormField[] = [];
            if (Array.isArray(raw.urlencoded)) {
                for (const item of raw.urlencoded as unknown[]) {
                    if (isObject(item) && item.disabled !== true && typeof item.key === "string") {
                        fields.push({ kind: "text", name: item.key, value: text(item.value) ?? "" });
                    }
                }
            }
            if (fields.length === 0) return { notes };
            return {
                body: { kind: "form", encoding: "urlencoded", fields },
                contentType: "application/x-www-form-urlencoded",
                notes,
            };
        }
        case "formdata": {
            const fields: FormField[] = [];
            if (Array.isArray(raw.formdata)) {
                for (const item of raw.formdata as unknown[]) {
                    if (!isObject(item) || item.disabled === true || typeof item.key !== "string") continue;
                    const contentType =
                        typeof item.contentType === "string" && item.contentType !== "" ? item.contentType : undefined;
                    if (item.type === "file") {
                        const sources = Array.isArray(item.src) ? (item.src as unknown[]) : [item.src];
                        const files = sources.filter(
                            (source): source is string => typeof source === "string" && source !== "",
                        );
                        if (files.length === 0)
                            notes.push(`the file field "${item.key}" has no file chosen, so it is left out`);
                        for (const file of files) {
                            const typed = contentType === undefined ? {} : { contentType };
                            fields.push({ kind: "file", name: item.key, file: { path: file }, ...typed });
                        }
                    } else {
                        const typed = contentType === undefined ? {} : { contentType };
                        fields.push({ kind: "text", name: item.key, value: text(item.value) ?? "", ...typed });
                    }
                }
            }
            if (fields.length === 0) return { notes };
            return { body: { kind: "form", encoding: "multipart", fields }, notes };
        }
        case "file": {
            const src = isObject(raw.file) ? raw.file.src : undefined;
            if (typeof src !== "string" || src === "") {
                notes.push("its body is a file, but no file is chosen, so it has no body");
                return { notes };
            }
            return { body: { kind: "file", file: { path: src } }, notes };
        }
        case "graphql": {
            const graphql = isObject(raw.graphql) ? raw.graphql : {};
            const query = typeof graphql.query === "string" ? graphql.query : "";
            if (query.trim() === "") return { notes };
            const variables =
                typeof graphql.variables === "string" && graphql.variables.trim() !== ""
                    ? graphql.variables
                    : undefined;
            return {
                body: { kind: "graphql", query, ...(variables === undefined ? {} : { variables }) },
                contentType: "application/json",
                notes,
            };
        }
        default:
            return { unsupported: `the body type "${raw.mode}" is not sent`, notes };
    }
}
