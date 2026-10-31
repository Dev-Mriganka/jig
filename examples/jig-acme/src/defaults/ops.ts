// Defaults for `ops`. A real company puts here its service catalog: for each service, where the code is, how CI runs, and for
// each environment how it is deployed, where it runs and how its health is checked.
//
// Acme's two services build on GitHub Actions, deploy with Helm and run on Kubernetes, one context per environment. `prod` has no
// `deploy` on purpose: without one, the agent cannot deploy there. Production is also never deployed to whatever is written here.
// A user's own `ci.auth` or `deploy` for a service replaces the company's whole; everything else merges key by key.
//
// `artifacts` says how to tell that a build is ready to deploy: a check named `build-image` whose log says `image: <name>`.

/** Where a service runs: a Kubernetes context, a namespace, and the label that selects its pods. */
const kubernetes = (context: string, namespace: string, app: string) => ({
    kubernetes: { context, namespace, selector: `app=${app}` },
});

/** A Helm release of the service's chart, with the values file of the environment. */
const helm = (release: string, environment: string) => ({
    method: "helm",
    release,
    chart: "deploy/chart",
    valuesFile: `deploy/values-${environment}.yaml`,
});

export const opsDefaults = {
    services: {
        "orders-api": {
            repo: "acme/orders-api",
            ci: { system: "github-actions", workflow: "build.yml" },
            environments: {
                dev: {
                    deploy: helm("orders-api", "dev"),
                    runtime: kubernetes("acme-dev", "orders", "orders-api"),
                    health: "https://orders-api.dev.acme.example/health",
                },
                staging: {
                    deploy: helm("orders-api", "staging"),
                    runtime: kubernetes("acme-staging", "orders", "orders-api"),
                    health: "https://orders-api.staging.acme.example/health",
                },
                prod: {
                    runtime: kubernetes("acme-prod", "orders", "orders-api"),
                    health: "https://orders-api.acme.example/health",
                },
            },
        },
        // A worker has no web address, so no health check by address.
        "billing-worker": {
            repo: "acme/billing-worker",
            ci: { system: "github-actions", workflow: "build.yml" },
            environments: {
                dev: {
                    deploy: helm("billing-worker", "dev"),
                    runtime: kubernetes("acme-dev", "billing", "billing-worker"),
                },
                staging: {
                    deploy: helm("billing-worker", "staging"),
                    runtime: kubernetes("acme-staging", "billing", "billing-worker"),
                },
                prod: {
                    runtime: kubernetes("acme-prod", "billing", "billing-worker"),
                },
            },
        },
    },
    artifacts: [{ kind: "image", check: "build-image", log: "image: (\\S+)" }],
};
