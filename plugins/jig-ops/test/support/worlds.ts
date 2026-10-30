// Worlds for the deploy tests: what the fake kubectl and helm answer when a service runs one version and a deploy is asked for.
//
//   orders-api in staging   a stateful set of two pods, deployed with helm
//   billing in staging      a deployment of two pods, deployed with kubectl set image
import { list, pod, workload } from "./fixtures.ts";
import type { World } from "./fake-programs.ts";

/** What helm prints for a good upgrade. */
export const UPGRADED =
    'Release "orders-api" has been upgraded. Happy Helming!\nNAME: orders-api\nLAST DEPLOYED: Thu Oct 15 09:00:00 2026\nNAMESPACE: orders-staging\nSTATUS: deployed\nREVISION: 5\n';

/** orders-api in staging, with both pods ready on `tag`. */
export function orders(tag = "1.4.2", more: World = {}): World {
    return {
        pods: list(pod("orders-api-0", { tag }), pod("orders-api-1", { tag })),
        workloads: list(workload("orders-api", { tag })),
        helmUpgrade: { stdout: UPGRADED },
        ...more,
    };
}

/** billing in staging, with both pods ready on `tag`, and the deployment's spec as `kubectl get deployment/billing` prints it. */
export function billing(tag = "2.0.0", more: World = {}): World {
    return {
        pods: list(pod("billing-0", { service: "billing", tag }), pod("billing-1", { service: "billing", tag })),
        workloads: list(workload("billing", { service: "billing", kind: "Deployment", tag })),
        workload: { stdout: workload("billing", { service: "billing", kind: "Deployment", tag }) },
        setImage: { stdout: "deployment.apps/billing image updated\n" },
        ...more,
    };
}

export const ORDERS = { service: "orders-api", environment: "staging" };
export const BILLING = { service: "billing", environment: "staging" };

/** The argument list `helm upgrade` is started with for orders-api in staging. */
export const upgradeArgs = (version: string): string[] => [
    "upgrade",
    "--install",
    "orders-api",
    "deploy/chart",
    "--kube-context",
    "test-cluster",
    "--namespace",
    "orders-staging",
    "--set",
    `image.tag=${version}`,
    "--wait=false",
];

/** The argument list `kubectl set image` is started with for billing in staging. */
export const setImageArgs = (image: string): string[] => [
    "--request-timeout=50s",
    "--context=test-cluster",
    "--namespace=billing-staging",
    "set",
    "image",
    "deployment/billing",
    `billing=${image}`,
];
