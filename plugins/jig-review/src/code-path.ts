// Which agent writes count as code worth a review offer. The agent also writes its own working files (notes, scratch
// files outside any repository); those changes are not code and must not open a review of the workspace.
import { existsSync } from "node:fs";
import path from "node:path";

const AGENT_DIRS = new Set([".pi"]);

/** True when `file` (absolute) is inside a git work tree and not in one of the agent's own folders. */
export function isReviewableWrite(file: string): boolean {
    const resolved = path.resolve(file);
    if (resolved.split(path.sep).some((part) => AGENT_DIRS.has(part))) return false;
    for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
        if (existsSync(path.join(dir, ".git"))) return true;
        if (path.dirname(dir) === dir) return false;
    }
}
