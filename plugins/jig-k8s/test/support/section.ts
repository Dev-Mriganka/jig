// The `k8s` section the tests configure: one service with a test and a production environment, and a second with one.
// The contexts, namespaces and selectors all differ, so a test can tell where a value came from.

export interface Raw {
    [key: string]: unknown;
}

export function section(extra: Raw = {}): Raw {
    return {
        services: {
            "orders-api": {
                staging: {
                    context: "test-cluster",
                    namespace: "orders-staging",
                    selector: "app=orders-api",
                    container: "orders-api",
                    port: 8080,
                },
                production: { context: "prod-cluster", namespace: "orders", selector: "app=orders-api,tier=web" },
            },
            billing: {
                staging: { context: "test-cluster", namespace: "billing-staging", selector: "app=billing" },
            },
        },
        ...extra,
    };
}

/** A copy of the default section with a change made to one entry. */
export function withEntry(service: string, environment: string, change: Raw): Raw {
    const raw = section() as { services: Record<string, Record<string, Raw>> };
    const entry = raw.services[service]?.[environment];
    if (entry === undefined) throw new Error(`no entry ${service}/${environment}`);
    Object.assign(entry, change);
    return raw;
}
