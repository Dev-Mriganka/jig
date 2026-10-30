// How jig-core is told what each call does: its environment and whether it reads or writes. What may not run throws a
// TypeError, which jig-core takes to mean "invalid input" and blocks without asking anyone. The kind of an environment (local,
// external, test or production) is asked of jig-core for every call, and a name it does not know counts as production.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { EnvironmentKind } from "../../jig-core/src/contract.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { podHealthInProduction, section, withCopy, withEnvironment } from "./support/section.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

type Input = Record<string, unknown>;
const ORDERS = { service: "orders-api", environment: "staging" };
const PRODUCTION = { service: "orders-api", environment: "production" };
const BILLING = { service: "billing", environment: "staging" };

type Said = { action?: string; environment: string; effect: string };

/** What a tool says about a call: its class, or the message of the TypeError that blocks it. */
function said(tool: "runtime" | "deploy", input: Input): Said | string {
    try {
        return h[tool].declaration.classify(input) as Said;
    } catch (error) {
        assert.ok(
            error instanceof TypeError,
            `${JSON.stringify(input)}: a refusal must be a TypeError, and was ${String(error)}`,
        );
        return error.message;
    }
}

describe("runtime: every action reads, in the environment of the call", () => {
    test("whatever the kind of the environment", () => {
        for (const kind of ["local", "external", "test", "production"] as EnvironmentKind[]) {
            h.jig.setKinds({ staging: kind });
            for (const action of ["pods", "rollout", "logs", "events"]) {
                assert.deepEqual(
                    said("runtime", { action, ...ORDERS }),
                    { action, environment: "staging", effect: "read" },
                    `${action} in ${kind}`,
                );
            }
        }
        assert.deepEqual(said("runtime", { action: "pods", ...PRODUCTION }), {
            action: "pods",
            environment: "production",
            effect: "read",
        });
    });

    test("an unknown service or environment, and a call that breaks a limit, are refused", () => {
        assert.match(
            said("runtime", { action: "pods", service: "nope", environment: "staging" }) as string,
            /^runtime: no service named "nope"/,
        );
        assert.match(
            said("runtime", { action: "pods", service: "orders-api", environment: "qa" }) as string,
            /^runtime: orders-api has no environment "qa"/,
        );
        assert.match(
            said("runtime", { action: "logs", ...ORDERS, tail: 5000 }) as string,
            /tail must be a whole number from 1 to 2000/,
        );
    });
});

describe("runtime health: by address anywhere, in a pod where it is not production", () => {
    test("an address is a read in the environment, production included", () => {
        assert.deepEqual(said("runtime", { action: "health", ...PRODUCTION }), {
            action: "health",
            environment: "production",
            effect: "read",
        });
        assert.deepEqual(said("runtime", { action: "health", ...BILLING }), {
            action: "health",
            environment: "staging",
            effect: "read",
        });
    });

    test("curl in a pod is a read in a test, local or external environment", () => {
        for (const kind of ["test", "local", "external"] as EnvironmentKind[]) {
            h.jig.setKinds({ staging: kind });
            assert.deepEqual(
                said("runtime", { action: "health", ...ORDERS }),
                { action: "health", environment: "staging", effect: "read" },
                kind,
            );
        }
    });

    test("curl in a pod is refused in production, by the kind jig-core gives the name", () => {
        const refused =
            /^runtime health is refused in production \(orders-api in (\w+)\): without a health address it would run curl inside a pod/;
        h.configure(podHealthInProduction());
        assert.match(said("runtime", { action: "health", ...PRODUCTION }) as string, refused);
        h.configure(section());
        h.jig.setKinds({ staging: "production" });
        assert.match(said("runtime", { action: "health", ...ORDERS }) as string, refused);
    });

    test("curl in a pod is refused under a name jig-core does not know, which counts as production", () => {
        h.configure(withCopy(section(), "orders-api", "staging", "preview"));
        assert.match(
            said("runtime", { action: "health", service: "orders-api", environment: "preview" }) as string,
            /^runtime health is refused in production \(orders-api in preview\)/,
        );
        h.jig.setKinds({ preview: "test" });
        assert.deepEqual(said("runtime", { action: "health", service: "orders-api", environment: "preview" }), {
            action: "health",
            environment: "preview",
            effect: "read",
        });
    });

    test("asks jig-core every time, so a change of kind applies to the next call", () => {
        h.jig.setKinds({ staging: "test" });
        assert.equal(typeof said("runtime", { action: "health", ...ORDERS }), "object");
        h.jig.setKinds({ staging: "production" });
        assert.equal(typeof said("runtime", { action: "health", ...ORDERS }), "string");
        h.jig.setKinds({ staging: "test" });
        assert.equal(typeof said("runtime", { action: "health", ...ORDERS }), "object");
    });

    test("the other actions are not refused in production: only curl in a pod is", () => {
        h.configure(podHealthInProduction());
        for (const action of ["pods", "rollout", "logs", "events"])
            assert.equal(typeof said("runtime", { action, ...PRODUCTION }), "object", action);
    });
});

describe("deploy: plan and status read, watch is a local write", () => {
    test("plan and status read in the environment of the call, production included, because they change nothing", () => {
        for (const environment of ["staging", "production"]) {
            assert.deepEqual(said("deploy", { action: "plan", service: "orders-api", environment, version: "1.4.3" }), {
                action: "plan",
                environment,
                effect: "read",
            });
            assert.deepEqual(said("deploy", { action: "status", service: "orders-api", environment }), {
                action: "status",
                environment,
                effect: "read",
            });
        }
    });

    test("watch is a write on this machine, in whatever environment it watches", () => {
        for (const environment of ["staging", "production"]) {
            assert.deepEqual(
                said("deploy", { action: "watch", service: "orders-api", environment, version: "1.4.3" }),
                { action: "watch", environment: "local", effect: "write" },
            );
        }
    });
});

describe("deploy run: a write in the environment, where the catalog has a method and jig-core does not say production", () => {
    const run = (input: Input = ORDERS) => said("deploy", { action: "run", ...input, version: "1.4.3" });

    test("a test environment with a deploy method", () => {
        assert.deepEqual(run(), { action: "run", environment: "staging", effect: "write" });
        assert.deepEqual(run(BILLING), { action: "run", environment: "staging", effect: "write" });
    });

    test("a local or an external environment is not refused by the tool: the rules table decides there", () => {
        for (const kind of ["local", "external"] as EnvironmentKind[]) {
            h.jig.setKinds({ staging: kind });
            assert.deepEqual(run(), { action: "run", environment: "staging", effect: "write" }, kind);
        }
    });

    test("production is refused", () => {
        h.jig.setKinds({ staging: "production" });
        assert.match(
            run() as string,
            /^deploy run is refused: orders-api in staging is production: the agent never changes production/,
        );
        assert.match(
            run(PRODUCTION) as string,
            /^deploy run is refused: orders-api in production is production: the agent never changes production$/,
        );
    });

    test("an environment the catalog gives no deploy method is refused", () => {
        h.configure(withEnvironment("orders-api", "staging", { deploy: undefined }));
        assert.equal(
            run(),
            "deploy run is refused: the catalog gives orders-api in staging no deploy method: the agent deploys only where the catalog names one",
        );
    });

    test("a name jig-core has never heard of is production, and is refused with how to define it", () => {
        h.configure(withCopy(section(), "orders-api", "staging", "preview"));
        assert.match(
            run({ service: "orders-api", environment: "preview" }) as string,
            /^deploy run is refused: orders-api in preview is production: .*define it under "environments" in jig\.json with kind test$/,
        );
        h.jig.setKinds({ preview: "test" });
        assert.deepEqual(run({ service: "orders-api", environment: "preview" }), {
            action: "run",
            environment: "preview",
            effect: "write",
        });
    });

    test("an unknown service or environment, and a version that is not an image tag, are refused", () => {
        assert.match(run({ service: "nope", environment: "staging" }) as string, /^deploy: no service named "nope"/);
        assert.match(
            run({ service: "orders-api", environment: "qa" }) as string,
            /^deploy: orders-api has no environment "qa"/,
        );
        assert.match(
            said("deploy", { action: "run", ...ORDERS, version: "-f" }) as string,
            /^deploy run: version must be an image tag/,
        );
        assert.match(said("deploy", { action: "run", ...ORDERS }) as string, /^deploy run needs version/);
    });
});

describe("deploy rollback: a write in a test environment only", () => {
    const rollback = (input: Input = ORDERS) => said("deploy", { action: "rollback", ...input });

    test("a test environment with a deploy method", () => {
        assert.deepEqual(rollback(), { action: "rollback", environment: "staging", effect: "write" });
        assert.deepEqual(rollback(BILLING), { action: "rollback", environment: "staging", effect: "write" });
    });

    test("not a local or an external environment", () => {
        for (const kind of ["local", "external"] as EnvironmentKind[]) {
            h.jig.setKinds({ staging: kind });
            assert.equal(
                rollback(),
                `deploy rollback is refused: a rollback works in test environments only, and staging is ${kind} for jig-core`,
                kind,
            );
        }
    });

    test("not production, not a name jig-core does not know, and not an environment without a method", () => {
        h.jig.setKinds({ staging: "production" });
        assert.match(rollback() as string, /^deploy rollback is refused: orders-api in staging is production/);
        assert.match(
            rollback(PRODUCTION) as string,
            /^deploy rollback is refused: orders-api in production is production/,
        );
        h.jig.setKinds({ staging: "test" });
        h.configure(withEnvironment("orders-api", "staging", { deploy: undefined }));
        assert.match(
            rollback() as string,
            /^deploy rollback is refused: the catalog gives orders-api in staging no deploy method/,
        );
        h.configure(withCopy(section(), "orders-api", "staging", "preview"));
        assert.match(rollback({ service: "orders-api", environment: "preview" }) as string, /is production/);
    });
});

describe("what a classification is", () => {
    test("a TypeError for what may not run, and an ordinary error for a bug here, which jig-core reports as undecided", () => {
        h.jig.api.config.section = () => {
            throw new TypeError("a bug, not an input");
        };
        for (const tool of ["runtime", "deploy"] as const) {
            assert.throws(
                () => h[tool].declaration.classify({ action: "pods", ...ORDERS }),
                (error: unknown) =>
                    error instanceof Error &&
                    !(error instanceof TypeError) &&
                    error.message === "internal error: a bug, not an input",
                tool,
            );
        }
    });

    test("says nothing but the action, the environment and the effect, and touches no cluster", () => {
        for (const input of [
            { action: "pods", ...ORDERS },
            { action: "health", ...BILLING },
        ]) {
            assert.deepEqual(Object.keys(h.runtime.declaration.classify(input) ?? {}).sort(), [
                "action",
                "effect",
                "environment",
            ]);
        }
        for (const input of [
            { action: "run", ...ORDERS, version: "1.4.3" },
            { action: "rollback", ...ORDERS },
            { action: "watch", ...ORDERS, version: "1.4.3" },
        ]) {
            assert.deepEqual(Object.keys(h.deploy.declaration.classify(input) ?? {}).sort(), [
                "action",
                "effect",
                "environment",
            ]);
        }
        assert.deepEqual(h.cluster.calls(), []);
        assert.deepEqual(h.cluster.helmCalls(), []);
        assert.deepEqual(h.jig.started, []);
    });
});
