// The `mongo` section most tests start from, and the secrets its references name.

export const STAGING_PASSWORD = { reference: "pass:mongo/staging", value: "stg-db-pass-4f9c2a71" };
export const PRODUCTION_PASSWORD = { reference: "pass:mongo/production", value: "prd-db-pass-8e1b6c05" };

/** A `mongo` section with a test environment (a deny list) and production (an allow list). */
export function defaultSection(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        connections: {
            staging: {
                uri: "mongodb://db.staging.example.com:27017",
                user: "agent",
                password: STAGING_PASSWORD.reference,
            },
            production: {
                uri: "mongodb://db.example.com:27017",
                user: "agent-readonly",
                password: PRODUCTION_PASSWORD.reference,
            },
        },
        access: {
            staging: { deny: ["billing.cards", "*.notes"] },
            production: {
                allow: {
                    "orders.orders": ["_id", "status", "items", "createdAt"],
                    "orders.customers": ["_id", "name"],
                },
            },
        },
        ...extra,
    };
}
