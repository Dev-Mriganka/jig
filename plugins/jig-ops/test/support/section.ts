// The `ops` section the tests configure: one service with a test and a production environment, and a second with one. The
// contexts, namespaces and selectors all differ, so a test can tell where a value came from.
//
//   orders-api  staging     deploys with helm, health check inside a pod (no address)
//               production  no deploy method, health by address
//   billing     staging     deploys with kubectl set image, health by address

export interface Raw {
    [key: string]: unknown;
}

export function section(extra: Raw = {}): Raw {
    return {
        services: {
            "orders-api": {
                repo: "acme/orders-api",
                ci: { system: "github-actions", workflow: "build.yml" },
                environments: {
                    staging: {
                        deploy: { method: "helm", release: "orders-api", chart: "deploy/chart" },
                        runtime: {
                            kubernetes: {
                                context: "test-cluster",
                                namespace: "orders-staging",
                                selector: "app=orders-api",
                                container: "orders-api",
                                port: 8080,
                                healthPath: "/actuator/health",
                            },
                        },
                    },
                    production: {
                        runtime: {
                            kubernetes: {
                                context: "prod-cluster",
                                namespace: "orders",
                                selector: "app=orders-api,tier=web",
                            },
                        },
                        health: "https://api.example.com/orders/health",
                    },
                },
            },
            billing: {
                environments: {
                    staging: {
                        deploy: { method: "kubectl-image", workload: "deployment/billing", container: "billing" },
                        runtime: {
                            kubernetes: {
                                context: "test-cluster",
                                namespace: "billing-staging",
                                selector: "app=billing",
                            },
                        },
                        health: "https://billing.staging.example.com/health",
                    },
                },
            },
        },
        ...extra,
    };
}

type Services = Record<string, { environments: Record<string, Raw> }>;

function entryOf(raw: Raw, service: string, environment: string): Raw {
    const found = (raw.services as Services)[service]?.environments[environment];
    if (found === undefined) throw new Error(`no entry ${service}/${environment}`);
    return found;
}

/** A copy of the default section with a change made to one environment's entry: its deploy, runtime or health. */
export function withEnvironment(service: string, environment: string, change: Raw): Raw {
    const raw = section();
    Object.assign(entryOf(raw, service, environment), change);
    return raw;
}

/** A copy of the default section with a change made to the `runtime.kubernetes` object of one environment. */
export function withEntry(service: string, environment: string, change: Raw): Raw {
    const raw = section();
    const runtime = entryOf(raw, service, environment).runtime as { kubernetes: Raw };
    Object.assign(runtime.kubernetes, change);
    return raw;
}

/** A copy of the default section with a change made to the `deploy` object of one environment. */
export function withDeploy(service: string, environment: string, change: Raw): Raw {
    const raw = section();
    Object.assign(entryOf(raw, service, environment).deploy as Raw, change);
    return raw;
}

/** A copy of the default section where orders-api in production has no address and checks its health inside a pod. */
export function podHealthInProduction(): Raw {
    const raw = withEnvironment("orders-api", "production", { health: undefined });
    const runtime = entryOf(raw, "orders-api", "production").runtime as { kubernetes: Raw };
    Object.assign(runtime.kubernetes, { container: "orders-api", port: 8080, healthPath: "/actuator/health" });
    return raw;
}

/** A copy of a section with an environment added to a service, as a copy of one it already has. */
export function withCopy(raw: Raw, service: string, from: string, name: string): Raw {
    const environments = (raw.services as Services)[service]?.environments;
    if (environments === undefined || environments[from] === undefined) throw new Error(`no entry ${service}/${from}`);
    environments[name] = structuredClone(environments[from]);
    return raw;
}

// ---- CI --------------------------------------------------------------------------------------------------------------

/** The address a CI entry names. The fake server answers it through `routeTo`. */
export const CI_URL = "https://ci.example.test";

/** The `ci` entry of a GitLab project whose token is the secret `env:GITLAB_TOKEN`. */
export function gitlabCi(more: Raw = {}): Raw {
    return { system: "gitlab", url: CI_URL, project: "acme/orders-api", auth: { token: "env:GITLAB_TOKEN" }, ...more };
}

/** The `ci` entry of a Jenkins job, signed in as `ci-bot` with the secret `env:JENKINS_TOKEN`. */
export function jenkinsCi(more: Raw = {}): Raw {
    return {
        system: "jenkins",
        url: CI_URL,
        job: "orders/build",
        auth: { user: "ci-bot", token: "env:JENKINS_TOKEN" },
        ...more,
    };
}

/** A copy of the default section where orders-api has this `ci` entry, and the other settings given. */
export function withCi(ci: Raw, more: Raw = {}): Raw {
    const raw = section(more);
    ((raw.services as Record<string, Raw>)["orders-api"] as Raw).ci = ci;
    return raw;
}
