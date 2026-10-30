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

/** Copies a fixture folder, with the example addresses replaced. */
function copyFixture(kind: "postman" | "http", into: string, replace: ReadonlyArray<readonly [string, string]>): string {
    const target = path.join(into, kind);
    fs.cpSync(path.join(FIXTURES, kind), target, { recursive: true });
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (/\.(?:json|http)$/.test(entry.name)) {
                fs.writeFileSync(full, replace.reduce((text, [from, to]) => text.split(from).join(to), fs.readFileSync(full, "utf8")));
            }
        }
    };
    visit(target);
    // The file a request must not reach sits beside the collections, as it does in the fixtures.
    fs.copyFileSync(path.join(FIXTURES, "outside.txt"), path.join(into, "outside.txt"));
    return target;
}

/**
 * The `api` section for both fixture collections: `acme` (Postman, environments `Staging` and `Production`) and `ledger`
 * (`.http` files, environments `staging` and `production`). Secrets are given per environment, so that a staging token is
 * never sent to production.
 */
export function acmeSection(h: Harness, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const into = path.join(h.dir, "acme");
    fs.mkdirSync(into, { recursive: true });
    const replace: Array<readonly [string, string]> = [
        ["https://api.staging.acme.example.test", h.api.origin],
        ["https://api.acme.example.test", h.prod.origin],
        ["https://auth.staging.acme.example.test", h.auth.origin],
        ["https://auth.acme.example.test", h.auth.origin],
    ];
    const postman = copyFixture("postman", into, replace);
    const http = copyFixture("http", into, replace);

    for (const { reference, value } of [...Object.values(TOKENS), SERVICE_USER, SERVICE_PASSWORD, API_KEY, CLIENT_SECRET]) h.jig.secrets.set(reference, value);
    const perEnvironment = (staging: string, production: string): Record<string, string> => ({
        Staging: staging, staging, Production: production, production,
    });
    return {
        collections: {
            acme: {
                postman: path.join(postman, "acme-orders.postman_collection.json"),
                environments: {
                    Staging: path.join(postman, "acme-staging.postman_environment.json"),
                    Production: path.join(postman, "acme-production.postman_environment.json"),
                },
            },
            ledger: { http },
        },
        environments: { Staging: "staging", Production: "production", staging: "staging", production: "production" },
        secrets: {
            token: perEnvironment(TOKENS.staging.reference, TOKENS.production.reference),
            serviceUser: SERVICE_USER.reference,
            servicePassword: SERVICE_PASSWORD.reference,
            apiKey: API_KEY.reference,
            clientSecret: CLIENT_SECRET.reference,
        },
        reads: ["Search orders"],
        adHoc: ["staging"],
        allowPlainLocal: true,
        ...extra,
    };
}

/** Sets the acme collections as the configuration of the harness. */
export function useAcme(h: Harness, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const section = acmeSection(h, extra);
    h.configure(section);
    return section;
}
