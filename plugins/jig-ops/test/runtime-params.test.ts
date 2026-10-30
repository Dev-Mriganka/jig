// The checks on a runtime call: its shape and its values. Every refusal is a TypeError (invalid input) whose message says how
// to put the call right.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readOps } from "../src/catalog.ts";
import type { Catalog } from "../src/catalog.ts";
import { DEFAULT_TAIL, DEFAULT_WAIT_SECONDS, parseCall, usage } from "../src/runtime/params.ts";
import { InputError } from "../src/values.ts";
import { section, withEnvironment } from "./support/section.ts";
import type { Raw } from "./support/section.ts";

function load(raw: Raw = section()): Catalog {
    const { catalog, errors } = readOps(raw);
    assert.deepEqual(errors, []);
    assert.ok(catalog);
    return catalog;
}

const catalog = load();
const POD = { service: "orders-api", environment: "staging" };

/** Asserts that a call is refused as invalid input, with a message that matches. */
function refused(input: Record<string, unknown>, message: RegExp | string, on: Catalog = catalog): void {
    assert.throws(
        () => parseCall(input, on),
        (error: unknown) => {
            assert.ok(error instanceof InputError, `${JSON.stringify(input)}: not an InputError`);
            assert.ok(
                error instanceof TypeError,
                "an InputError is a TypeError, which jig-core reads as invalid input",
            );
            if (typeof message === "string") assert.equal(error.message, message);
            else assert.match(error.message, message);
            return true;
        },
        JSON.stringify(input),
    );
}

describe("the shape of a call", () => {
    test("a tool that is not set up says what to add", () => {
        assert.throws(
            () => parseCall({ action: "pods", ...POD }, undefined),
            (error: unknown) =>
                error instanceof TypeError &&
                error.message ===
                    'ops is not set up: add an "ops" section with "services" to jig.json (/jig lists configuration problems)',
        );
    });

    test("an action is needed, and is one of five", () => {
        refused(
            { ...POD },
            /^runtime needs action: pods, rollout, logs, events, health\. Usage: runtime \{action, service, environment, \.\.\.\}/,
        );
        refused(
            { action: "restart", ...POD },
            /^runtime: action must be one of pods, rollout, logs, events, health \(got "restart"\)\. Usage: /,
        );
        for (const action of [
            "delete",
            "scale",
            "apply",
            "exec",
            "port-forward",
            "cp",
            "status",
            "api",
            "GET",
            "Pods",
            5,
            ["pods"],
            {},
        ]) {
            refused({ action, ...POD }, /^runtime: action must be one of pods, rollout, logs, events, health/);
        }
    });

    test("a call names its service and its environment", () => {
        refused(
            { action: "pods", environment: "staging" },
            /^runtime pods needs service\. Known services: orders-api \(staging, production\), billing \(staging\)\. Usage: runtime pods \{service, environment\}$/,
        );
        refused(
            { action: "pods", service: "billing" },
            "runtime pods needs environment. Usage: runtime pods {service, environment}",
        );
        refused(
            { action: "logs" },
            /^runtime logs needs service, environment\. Known services: .* Usage: runtime logs \{service, environment, pod\?, container\?, tail\?, sinceSeconds\?, previous\?\}$/,
        );
    });

    test("a parameter the action does not use is refused, with the usage line of that action", () => {
        refused(
            { action: "pods", ...POD, tail: 5 },
            "runtime pods does not use tail. Usage: runtime pods {service, environment}",
        );
        refused(
            { action: "logs", ...POD, waitFor: "1.4.2" },
            "runtime logs does not use waitFor. Usage: runtime logs {service, environment, pod?, container?, tail?, sinceSeconds?, previous?}",
        );
        refused(
            { action: "rollout", ...POD, tail: 5 },
            "runtime rollout does not use tail. Usage: runtime rollout {service, environment, waitFor?, timeoutSec?}",
        );
        refused(
            { action: "events", ...POD, previous: true },
            "runtime events does not use previous. Usage: runtime events {service, environment}",
        );
        refused(
            { action: "pods", ...POD, context: "other", namespace: "kube-system" },
            "runtime pods does not use context, namespace. Usage: runtime pods {service, environment}",
        );
    });

    test("no call can name a context, a namespace, a selector, an address, a path, a flag or a verb", () => {
        const names = [
            "context",
            "namespace",
            "selector",
            "kubeconfig",
            "server",
            "token",
            "user",
            "cluster",
            "verb",
            "args",
            "command",
            "flags",
            "all",
            "allNamespaces",
            "output",
            "url",
            "path",
            "port",
            "method",
            "headers",
            "body",
        ];
        for (const action of ["pods", "rollout", "logs", "events", "health"]) {
            for (const name of names) {
                refused({ action, ...POD, [name]: "value" }, new RegExp(`^runtime ${action} does not use ${name}\\.`));
            }
        }
    });

    test("null counts as not given, as models often send null for a field they do not use", () => {
        const call = parseCall(
            { action: "logs", ...POD, pod: null, container: null, tail: null, sinceSeconds: null, previous: null },
            catalog,
        );
        assert.deepEqual(
            call.action === "logs" && [call.pod, call.container, call.tail, call.sinceSeconds, call.previous],
            [undefined, undefined, DEFAULT_TAIL, undefined, false],
        );
        refused({ action: "pods", ...POD, service: null }, /^runtime pods needs service\./);
    });

    test("an unknown service or environment lists the known ones", () => {
        refused(
            { action: "pods", service: "nope", environment: "staging" },
            'runtime: no service named "nope". Known services: orders-api (staging, production), billing (staging)',
        );
        refused(
            { action: "pods", service: "orders-api", environment: "qa" },
            'runtime: orders-api has no environment "qa". Known environments: staging, production',
        );
        refused(
            { action: "pods", service: "billing", environment: "production" },
            /^runtime: billing has no environment "production"\. Known environments: staging$/,
        );
    });
});

describe("pods and events", () => {
    test("take only a service and an environment, and read the cluster the catalog names", () => {
        for (const action of ["pods", "events"] as const) {
            const call = parseCall({ action, ...POD }, catalog);
            assert.equal(call.action, action);
            if (call.action === "pods" || call.action === "events") {
                assert.equal(call.target.namespace, "orders-staging");
                assert.equal(call.target.context, "test-cluster");
                assert.equal(call.env.name, "staging");
            }
        }
    });

    test("an environment with no Kubernetes runtime has nothing to read, and the message says what it has", () => {
        const onlyHealth = load({
            services: { svc: { environments: { staging: { health: "https://svc.example.test/health" } } } },
        });
        for (const action of ["pods", "rollout", "logs", "events"]) {
            refused(
                { action, service: "svc", environment: "staging" },
                `runtime ${action}: svc in staging has no Kubernetes runtime in the catalog (it has a health address only)`,
                onlyHealth,
            );
        }
        assert.equal(
            parseCall({ action: "health", service: "svc", environment: "staging" }, onlyHealth).action,
            "health",
        );
    });
});

describe("rollout", () => {
    test("waits for nothing unless it is told what to wait for, and then for 300 seconds", () => {
        const plain = parseCall({ action: "rollout", ...POD }, catalog);
        assert.deepEqual(plain.action === "rollout" && [plain.waitFor, plain.timeoutSec], [
            undefined,
            DEFAULT_WAIT_SECONDS,
        ]);
        const waiting = parseCall({ action: "rollout", ...POD, waitFor: "1.4.3" }, catalog);
        assert.deepEqual(waiting.action === "rollout" && [waiting.waitFor, waiting.timeoutSec], ["1.4.3", 300]);
    });

    test("a version is an image tag, as pods shows it", () => {
        for (const waitFor of [
            "1.4.2",
            "v1.4.2",
            "0.0.0-pr-feature-abc-1f2e3d4",
            "sha-abcdef0",
            "1.4.2_rc1",
            "1.4.2+build.5",
            "latest",
            "7",
            "a".repeat(128),
        ]) {
            const call = parseCall({ action: "rollout", ...POD, waitFor }, catalog);
            assert.equal(call.action === "rollout" && call.waitFor, waitFor);
        }
        for (const waitFor of [
            "",
            "-1",
            "--delete",
            "1.4.2 ",
            " 1.4.2",
            "a b",
            "x:y",
            "x/y",
            "x@sha256:1",
            "a;b",
            "$(id)",
            "a".repeat(129),
            5,
            true,
            ["1"],
        ]) {
            refused(
                { action: "rollout", ...POD, waitFor },
                /^runtime rollout: waitFor must be an image tag or version, such as 1\.4\.2 \(got /,
            );
        }
    });

    test("the wait is at most ten minutes", () => {
        for (const timeoutSec of [1, 60, 600]) {
            const call = parseCall({ action: "rollout", ...POD, waitFor: "1.4.2", timeoutSec }, catalog);
            assert.equal(call.action === "rollout" && call.timeoutSec, timeoutSec);
        }
        for (const timeoutSec of [0, -1, 601, 1.5, "60", true, Number.NaN, Infinity]) {
            refused(
                { action: "rollout", ...POD, waitFor: "1.4.2", timeoutSec },
                /^runtime rollout: timeoutSec must be a whole number from 1 to 600 \(got /,
            );
        }
    });

    test("a timeout without something to wait for is refused", () => {
        refused({ action: "rollout", ...POD, timeoutSec: 30 }, "runtime rollout: timeoutSec is used only with waitFor");
    });
});

describe("logs", () => {
    test("reads 200 lines of the first ready pod unless it is told otherwise", () => {
        const call = parseCall({ action: "logs", ...POD }, catalog);
        assert.deepEqual(call, {
            action: "logs",
            env: call.env,
            target: call.action === "logs" ? call.target : undefined,
            pod: undefined,
            container: undefined,
            tail: 200,
            sinceSeconds: undefined,
            previous: false,
        });
    });

    test("takes a pod, a container, a tail, a window and the previous run", () => {
        const call = parseCall(
            {
                action: "logs",
                ...POD,
                pod: "orders-api-0",
                container: "orders-api",
                tail: 50,
                sinceSeconds: 90,
                previous: true,
            },
            catalog,
        );
        assert.deepEqual(
            call.action === "logs" && [call.pod, call.container, call.tail, call.sinceSeconds, call.previous],
            ["orders-api-0", "orders-api", 50, 90, true],
        );
    });

    test("a tail is 1 to 2000 lines", () => {
        for (const tail of [1, 2000]) assert.equal(parseCall({ action: "logs", ...POD, tail }, catalog).action, "logs");
        for (const tail of [0, -5, 2001, 10.5, "200", Number.NaN, true]) {
            refused(
                { action: "logs", ...POD, tail },
                /^runtime logs: tail must be a whole number from 1 to 2000 \(got /,
            );
        }
    });

    test("a window is 1 second to a day", () => {
        for (const sinceSeconds of [1, 86_400])
            assert.equal(parseCall({ action: "logs", ...POD, sinceSeconds }, catalog).action, "logs");
        for (const sinceSeconds of [0, 86_401, 1.5, "60", -1]) {
            refused(
                { action: "logs", ...POD, sinceSeconds },
                /^runtime logs: sinceSeconds must be a whole number from 1 to 86400 \(got /,
            );
        }
    });

    test("a pod and a container are names, and never a flag", () => {
        for (const pod of ["orders-api-0", "orders-api-6d4f9c7b8-x2k9q", "a", "pod.with.dots"]) {
            assert.equal(parseCall({ action: "logs", ...POD, pod }, catalog).action, "logs", pod);
        }
        for (const pod of [
            "",
            "-A",
            "--all-containers",
            "../x",
            "a b",
            "Pod",
            "a;b",
            "$(id)",
            "a/b",
            "x".repeat(254),
            5,
        ]) {
            refused({ action: "logs", ...POD, pod }, /^runtime logs: pod must be a pod name, as pods shows it \(got /);
        }
        for (const container of ["", "-c", "--previous", "Main", "a b", "x".repeat(64), 5]) {
            refused({ action: "logs", ...POD, container }, /^runtime logs: container must be a container name \(got /);
        }
    });

    test("previous is true or false", () => {
        for (const previous of ["true", 1, "yes", []]) {
            refused({ action: "logs", ...POD, previous }, /^runtime logs: previous must be true or false \(got /);
        }
    });
});

describe("health", () => {
    test("takes no path, address or method: the catalog's address is the one that is called", () => {
        const call = parseCall({ action: "health", service: "orders-api", environment: "production" }, catalog);
        assert.deepEqual(call.action === "health" && call.how, {
            kind: "url",
            url: "https://api.example.com/orders/health",
        });
    });

    test("checks inside a pod when the environment has no address but a health path, a port and a container", () => {
        const call = parseCall({ action: "health", ...POD }, catalog);
        assert.equal(call.action === "health" && call.how.kind, "pod");
        if (call.action === "health" && call.how.kind === "pod") {
            assert.deepEqual(
                [call.how.target.container, call.how.target.port, call.how.target.healthPath],
                ["orders-api", 8080, "/actuator/health"],
            );
        }
    });

    test("prefers the address when the environment has both", () => {
        const both = load(
            withEnvironment("orders-api", "staging", { health: "https://orders.staging.example.com/health" }),
        );
        const call = parseCall({ action: "health", ...POD }, both);
        assert.deepEqual(call.action === "health" && call.how, {
            kind: "url",
            url: "https://orders.staging.example.com/health",
        });
    });

    test("an environment with neither says what to add", () => {
        const none = load(withEnvironment("billing", "staging", { health: undefined }));
        refused(
            { action: "health", service: "billing", environment: "staging" },
            'runtime health: billing in staging has no health check in the catalog. Add "health" (an https address), or healthPath, port and container to its Kubernetes runtime',
            none,
        );
    });
});

describe("the usage lines", () => {
    test("name every parameter an action takes", () => {
        assert.equal(usage("pods"), "Usage: runtime pods {service, environment}");
        assert.equal(usage("rollout"), "Usage: runtime rollout {service, environment, waitFor?, timeoutSec?}");
        assert.equal(
            usage("logs"),
            "Usage: runtime logs {service, environment, pod?, container?, tail?, sinceSeconds?, previous?}",
        );
        assert.equal(usage("events"), "Usage: runtime events {service, environment}");
        assert.equal(usage("health"), "Usage: runtime health {service, environment}");
    });
});
