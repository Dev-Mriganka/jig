// Helpers for the integration tests (`plugins/*/test/it/*.test.ts`, run by `npm run test:it`). Each of those tests needs a
// real service, which it finds by an environment variable that holds the service's address. When the variables are not
// set, the suite is skipped and says what to set. CI sets `JIG_IT_REQUIRE` to the services its workflow starts, so a
// service that failed to start fails the run instead of making it quietly skip.
import { describe, test } from "node:test";

/** What a suite needs: the service's name, the variables that hold its address, and a hint for the person running it. */
export interface Need {
    /** A short lower-case name, such as `elasticsearch`. `JIG_IT_REQUIRE` lists these. */
    service: string;
    /** Every one of these must be set (non-empty) for the suite to run. */
    variables: readonly string[];
    /** What to start, in a few words: "a throwaway Elasticsearch 8 with security on". */
    hint: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The variables of a need that are not set. */
export function missing(need: Need, env: Env = process.env): string[] {
    return need.variables.filter((name) => (env[name] ?? "") === "");
}

/** The services CI says must be there: a comma-separated list in `JIG_IT_REQUIRE`. */
export function requiredServices(env: Env = process.env): string[] {
    return (env.JIG_IT_REQUIRE ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
}

/** What happens to a suite: it runs, is skipped with a reason, or fails because CI promised the service. */
export type Plan = { kind: "run" } | { kind: "skip"; reason: string } | { kind: "fail"; reason: string };

export function plan(need: Need, env: Env = process.env): Plan {
    const absent = missing(need, env);
    if (absent.length === 0) return { kind: "run" };
    const what = `${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not set`;
    if (requiredServices(env).includes(need.service)) {
        return { kind: "fail", reason: `${what}, but JIG_IT_REQUIRE lists ${need.service}: the service did not start` };
    }
    return {
        kind: "skip",
        reason: `${what}: start ${need.hint} and set the variables (see docs/integration-tests.md)`,
    };
}

/** A variable that must be set. Read it inside `before` or a test, not when the file loads. */
export function must(name: string, env: Env = process.env): string {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`${name} is not set`);
    return value;
}

/** A variable that may be absent. */
export function optional(name: string, env: Env = process.env): string | undefined {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
}

/**
 * A suite that needs a real service. Without the variables it is skipped, naming them; when CI requires the service it
 * fails with one test that says so. `body` only runs when the service is configured, so it may read the variables
 * freely.
 */
export function describeIt(title: string, need: Need, body: () => void): void {
    const chosen = plan(need);
    if (chosen.kind === "run") {
        describe(title, body);
    } else if (chosen.kind === "skip") {
        describe(title, { skip: chosen.reason }, () => {});
    } else {
        describe(title, () => {
            test(`${need.service} is available`, () => {
                throw new Error(chosen.reason);
            });
        });
    }
}
