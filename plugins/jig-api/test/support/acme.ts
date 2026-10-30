// The example company's collections, from test/fixtures, copied into a test's folder with their example addresses replaced by
// the fake servers on this machine, and the `api` section that goes with them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "./harness.ts";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export const TOKENS = {
    staging: { reference: "pass:acme/staging-token", value: "stg-token-4f9c2a71d3e8" },
    production: { reference: "pass:acme/production-token", value: "prd-token-8e1b6c05a9d2" },
};
export const SERVICE_USER = { reference: "pass:acme/service-user", value: "svc-orders-user" };
export const SERVICE_PASSWORD = { reference: "pass:acme/service-password", value: "svc-p@ss word&1=CANARY" };
export const API_KEY = { reference: "pass:acme/api-key", value: "key-7d3f9a41c5e2b860" };
export const CLIENT_SECRET = { reference: "pass:acme/client-secret", value: "acme-client-secret-CANARY-31" };
export const REPORT_KEY = { reference: "pass:acme/report-key", value: "rpt-key-2b7e9d4c01a5" };
export const CLIENT_ID = { reference: "pass:acme/client-id", value: "acme-orders-cli" };

/** Copies a fixture folder, with the example addresses replaced. */
function copyFixture(kind: string, into: string, replace: ReadonlyArray<readonly [string, string]>): string {
    const target = path.join(into, kind);
    fs.cpSync(path.join(FIXTURES, kind), target, { recursive: true });
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (/\.(?:json|http|ya?ml|bru)$/.test(entry.name)) {
                fs.writeFileSync(full, replace.reduce((text, [from, to]) => text.split(from).join(to), fs.readFileSync(full, "utf8")));
            }
        }
    };
    visit(target);
    // The file a request must not reach sits beside the collections, as it does in the fixtures.
    fs.copyFileSync(path.join(FIXTURES, "outside.txt"), path.join(into, "outside.txt"));
    return target;
}

/** The example addresses, and the fake servers on this machine that stand in for them. */
function addresses(h: Harness): Array<readonly [string, string]> {
    return [
        ["https://api.staging.acme.example.test", h.api.origin],
        ["https://api.acme.example.test", h.prod.origin],
        ["https://auth.staging.acme.example.test", h.auth.origin],
        ["https://auth.acme.example.test", h.auth.origin],
    ];
}

/** Copies one fixture folder into the test's own, with its addresses pointing at the fake servers. */
export function copyAcme(h: Harness, kind: string): string {
    const into = path.join(h.dir, "acme");
    fs.mkdirSync(into, { recursive: true });
    return copyFixture(kind, into, addresses(h));
}

/** Everything of an `api` section but its collections: the environments, the secrets (given per environment, so that a staging
 *  token is never sent to production), and the switches. The secrets' values are set in the fake jig-core. */
export function acmeSettings(h: Harness, collections: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
    for (const { reference, value } of [...Object.values(TOKENS), SERVICE_USER, SERVICE_PASSWORD, API_KEY, CLIENT_SECRET, REPORT_KEY, CLIENT_ID]) h.jig.secrets.set(reference, value);
    const perEnvironment = (staging: string, production: string): Record<string, string> => ({
        Staging: staging, staging, Production: production, production,
    });
    return {
        collections,
        environments: { Staging: "staging", Production: "production", staging: "staging", production: "production" },
        secrets: {
            token: perEnvironment(TOKENS.staging.reference, TOKENS.production.reference),
            serviceUser: SERVICE_USER.reference,
            servicePassword: SERVICE_PASSWORD.reference,
            apiKey: API_KEY.reference,
            clientSecret: CLIENT_SECRET.reference,
            "process.env.ACME_REPORT_KEY": REPORT_KEY.reference,
            // The credential slots of the OpenAPI fixture are named for their security schemes.
            bearerAuth: perEnvironment(TOKENS.staging.reference, TOKENS.production.reference),
            "basicAuth.username": SERVICE_USER.reference,
            "basicAuth.password": SERVICE_PASSWORD.reference,
            apiKeyAuth: API_KEY.reference,
            "clientCredentials.clientId": CLIENT_ID.reference,
            "clientCredentials.clientSecret": CLIENT_SECRET.reference,
            "passwordFlow.clientId": CLIENT_ID.reference,
            "passwordFlow.clientSecret": CLIENT_SECRET.reference,
            "passwordFlow.username": SERVICE_USER.reference,
            "passwordFlow.password": SERVICE_PASSWORD.reference,
        },
        reads: ["Search orders"],
        adHoc: ["staging"],
        allowPlainLocal: true,
        ...extra,
    };
}

/**
 * The `api` section for both part 1 fixture collections: `acme` (Postman, environments `Staging` and `Production`) and `ledger`
 * (`.http` files, environments `staging` and `production`).
 */
export function acmeSection(h: Harness, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const postman = copyAcme(h, "postman");
    const http = copyAcme(h, "http");
    return acmeSettings(h, {
        acme: {
            postman: path.join(postman, "acme-orders.postman_collection.json"),
            environments: {
                Staging: path.join(postman, "acme-staging.postman_environment.json"),
                Production: path.join(postman, "acme-production.postman_environment.json"),
            },
        },
        ledger: { http },
    }, extra);
}

/** Sets the acme collections as the configuration of the harness. */
export function useAcme(h: Harness, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const section = acmeSection(h, extra);
    h.configure(section);
    return section;
}

/** The `api` section for the Bruno fixture in one of its formats, as the collection `acme` (environments `Staging`, `Production`). */
export function brunoSection(h: Harness, format: "yaml" | "bru", extra: Record<string, unknown> = {}): Record<string, unknown> {
    return acmeSettings(h, { acme: { bruno: copyAcme(h, `bruno-${format}`) } }, extra);
}

/** Sets the Bruno fixture as the configuration of the harness. */
export function useBruno(h: Harness, format: "yaml" | "bru", extra: Record<string, unknown> = {}): Record<string, unknown> {
    const section = brunoSection(h, format, extra);
    h.configure(section);
    return section;
}

/**
 * The `api` section for the OpenAPI fixture, as the collection `acme`. By default it may run in `Staging` only, against the fake
 * API; `collection` replaces fields of the collection's own configuration (`environments`, `servers`, `allowProductionReads`).
 */
export function openapiSection(h: Harness, format: "yaml" | "json", collection: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const file = path.join(copyAcme(h, "openapi"), `acme-orders.openapi.${format}`);
    const environments = Array.isArray(collection.environments) ? (collection.environments as string[]) : ["Staging"];
    const known: Record<string, string> = { Staging: `${h.api.origin}/v1`, Production: `${h.prod.origin}/v1` };
    const servers = Object.fromEntries(environments.filter((name) => name in known).map((name) => [name, known[name]]));
    return acmeSettings(h, { acme: { openapi: file, environments, servers, ...collection } }, extra);
}

/** Sets the OpenAPI fixture as the configuration of the harness. */
export function useOpenApi(h: Harness, format: "yaml" | "json", collection: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const section = openapiSection(h, format, collection, extra);
    h.configure(section);
    return section;
}
