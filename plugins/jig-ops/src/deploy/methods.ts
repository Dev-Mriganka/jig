// The deploy methods there are, in one place: the catalog checks an environment's `deploy` object with checkDeploy, and the
// deploy tool turns it into a Deployer with deployerOf. A new method (a GitOps pull request, a CI deploy job) is a file
// beside helm.ts, a case in each of the two functions below, and its name in METHODS.
import { isObject } from "../values.ts";
import type { Deployer } from "./command.ts";
import { checkHelm, helmDeployer } from "./helm.ts";
import type { HelmDeploy } from "./helm.ts";
import { checkKubectlImage, kubectlImageDeployer } from "./kubectl-image.ts";
import type { KubectlImageDeploy } from "./kubectl-image.ts";

export type DeployConfig = HelmDeploy | KubectlImageDeploy;

export const METHODS = ["helm", "kubectl-image"] as const;

/** Checks the `deploy` object of an environment and reads it, or adds the problems to `errors`. */
export function checkDeploy(raw: unknown, at: string, errors: string[]): DeployConfig | undefined {
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object with a method: ${METHODS.join(" or ")}`);
        return undefined;
    }
    switch (raw.method) {
        case "helm":
            return checkHelm(raw, at, errors);
        case "kubectl-image":
            return checkKubectlImage(raw, at, errors);
        case undefined:
            errors.push(`${at}.method: required, ${METHODS.join(" or ")}`);
            return undefined;
        default:
            errors.push(`${at}.method: must be ${METHODS.join(" or ")}`);
            return undefined;
    }
}

export function deployerOf(config: DeployConfig): Deployer {
    switch (config.method) {
        case "helm":
            return helmDeployer(config);
        case "kubectl-image":
            return kubectlImageDeployer(config);
    }
}
