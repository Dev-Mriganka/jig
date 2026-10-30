// The CI systems there are. A new one is a file beside the others that exports a `CiSystemInfo`, a name in CI_SYSTEMS
// (see config.ts) and a row here.
import type { CiSystemInfo } from "./adapter.ts";
import type { CiSystem } from "./config.ts";
import { GITHUB_ACTIONS } from "./github-actions.ts";
import { GITLAB } from "./gitlab.ts";
import { JENKINS } from "./jenkins.ts";

export const SYSTEMS: Readonly<Record<CiSystem, CiSystemInfo>> = {
    "github-actions": GITHUB_ACTIONS,
    gitlab: GITLAB,
    jenkins: JENKINS,
};
