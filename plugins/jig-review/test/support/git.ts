// Synchronous git for building the repositories a test works on, with an identity and no user configuration.
import { execFileSync } from "node:child_process";

const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
};

export const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });
