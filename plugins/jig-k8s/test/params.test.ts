// The checks on a call: its shape, its values, and the path of an api call. Every refusal is a TypeError (invalid input)
// whose message says how to put the call right.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readK8s } from "../src/config.ts";
import type { K8sSettings } from "../src/config.ts";
import { InputError } from "../src/values.ts";
import { DEFAULT_TAIL, DEFAULT_WAIT_SECONDS, parseCall, usage } from "../src/params.ts";
import { section, withEntry } from "./support/section.ts";
import type { Raw } from "./support/section.ts";

function load(raw: Raw = section()): K8sSettings {
    const { settings, errors } = readK8s(raw);
    assert.deepEqual(errors, []);
    assert.ok(settings);
    return settings;
}

const settings = load();
const POD = { service: "orders-api", environment: "staging" };

/** Asserts that a call is refused as invalid input, with a message that matches. */
function refused(input: Record<string, unknown>, message: RegExp | string, on: K8sSettings = settings): void {
    assert.throws(
        () => parseCall(input, on),
        (error: unknown) => {
            assert.ok(error instanceof InputError, `${JSON.stringify(input)}: not an InputError`);
            assert.ok(error instanceof TypeError, "an InputError is a TypeError, which jig-core reads as invalid input");
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
                error.message === 'k8s is not set up: add a "k8s" section with "services" to jig.json (/jig lists configuration problems)',
        );
    });

    test("an action is needed, and is one of four", () => {
        refused({ ...POD }, /^k8s needs action: pods, status, logs, api\. Usage: k8s \{action, service, environment, \.\.\.\}/);
        refused({ action: "restart", ...POD }, /^k8s: action must be one of pods, status, logs, api \(got "restart"\)\. Usage: /);
        for (const action of ["delete", "scale", "apply", "exec", "port-forward", "cp", "rollout", "GET", "Pods", 5, ["pods"], {}]) {
            refused({ action, ...POD }, /^k8s: action must be one of pods, status, logs, api/);
        }
    });

    test("a call names its service and its environment", () => {
        refused({ action: "pods", environment: "staging" }, /^k8s pods needs service\. Known services: orders-api \(staging, production\), billing \(staging\)\. Usage: k8s pods \{service, environment\}$/);
        refused({ action: "pods", service: "billing" }, "k8s pods needs environment. Usage: k8s pods {service, environment}");
        refused({ action: "logs" }, /^k8s logs needs service, environment\. Known services: .* Usage: k8s logs \{service, environment, pod\?, container\?, tail\?, sinceSeconds\?, previous\?\}$/);
    });

    test("a parameter the action does not use is refused, with the usage line of that action", () => {
        refused({ action: "pods", ...POD, tail: 5 }, "k8s pods does not use tail. Usage: k8s pods {service, environment}");
        refused({ action: "logs", ...POD, waitFor: "1.4.2" }, "k8s logs does not use waitFor. Usage: k8s logs {service, environment, pod?, container?, tail?, sinceSeconds?, previous?}");
        refused({ action: "status", ...POD, path: "/x" }, "k8s status does not use path. Usage: k8s status {service, environment, waitFor?, timeoutSec?}");
        refused({ action: "pods", ...POD, context: "other", namespace: "kube-system" }, "k8s pods does not use context, namespace. Usage: k8s pods {service, environment}");
    });

    test("no call can name a context, a namespace, a selector, a flag or a verb", () => {
        const names = ["context", "namespace", "selector", "kubeconfig", "server", "token", "user", "cluster", "verb", "args", "command", "flags", "all", "allNamespaces", "output"];
        for (const action of ["pods", "status", "logs", "api"]) {
            for (const name of names) {
                const given = action === "api" ? { path: "/x" } : {};
                refused({ action, ...POD, ...given, [name]: "value" }, new RegExp(`^k8s ${action} does not use ${name}\\.`));
            }
        }
    });

    test("null counts as not given, as models often send null for a field they do not use", () => {
        const call = parseCall({ action: "logs", ...POD, pod: null, container: null, tail: null, sinceSeconds: null, previous: null }, settings);
        assert.deepEqual(call.action === "logs" && [call.pod, call.container, call.tail, call.sinceSeconds, call.previous], [undefined, undefined, DEFAULT_TAIL, undefined, false]);
        refused({ action: "pods", ...POD, service: null }, /^k8s pods needs service\./);
    });

    test("an unknown service or environment lists the known ones", () => {
        refused({ action: "pods", service: "nope", environment: "staging" }, 'k8s: no service named "nope". Known services: orders-api (staging, production), billing (staging)');
        refused({ action: "pods", service: "orders-api", environment: "qa" }, 'k8s: orders-api has no environment "qa". Known environments: staging, production');
        refused({ action: "pods", service: "billing", environment: "production" }, /^k8s: billing has no environment "production"\. Known environments: staging$/);
    });
});

describe("pods", () => {
    test("takes only a service and an environment", () => {
        const call = parseCall({ action: "pods", ...POD }, settings);
        assert.equal(call.action, "pods");
        assert.equal(call.target.namespace, "orders-staging");
        assert.equal(call.target.context, "test-cluster");
    });
});

describe("status", () => {
    test("waits for nothing unless it is told what to wait for, and then for 300 seconds", () => {
        const plain = parseCall({ action: "status", ...POD }, settings);
        assert.deepEqual(plain.action === "status" && [plain.waitFor, plain.timeoutSec], [undefined, DEFAULT_WAIT_SECONDS]);
        const waiting = parseCall({ action: "status", ...POD, waitFor: "1.4.3" }, settings);
        assert.deepEqual(waiting.action === "status" && [waiting.waitFor, waiting.timeoutSec], ["1.4.3", 300]);
    });

    test("a version is an image tag, as pods shows it", () => {
        for (const waitFor of ["1.4.2", "v1.4.2", "0.0.0-pr-feature-abc-1f2e3d4", "sha-abcdef0", "1.4.2_rc1", "1.4.2+build.5", "latest", "7", "a".repeat(128)]) {
            const call = parseCall({ action: "status", ...POD, waitFor }, settings);
            assert.equal(call.action === "status" && call.waitFor, waitFor);
        }
        for (const waitFor of ["", "-1", "--delete", "1.4.2 ", " 1.4.2", "a b", "x:y", "x/y", "x@sha256:1", "a;b", "$(id)", "a".repeat(129), 5, true, ["1"]]) {
            refused({ action: "status", ...POD, waitFor }, /^k8s status: waitFor must be an image tag or version, such as 1\.4\.2 \(got /);
        }
    });

    test("the wait is at most ten minutes", () => {
        for (const timeoutSec of [1, 60, 600]) {
            const call = parseCall({ action: "status", ...POD, waitFor: "1.4.2", timeoutSec }, settings);
            assert.equal(call.action === "status" && call.timeoutSec, timeoutSec);
        }
        for (const timeoutSec of [0, -1, 601, 1.5, "60", true, Number.NaN, Infinity]) {
            refused({ action: "status", ...POD, waitFor: "1.4.2", timeoutSec }, /^k8s status: timeoutSec must be a whole number from 1 to 600 \(got /);
        }
    });

    test("a timeout without something to wait for is refused", () => {
        refused({ action: "status", ...POD, timeoutSec: 30 }, "k8s status: timeoutSec is used only with waitFor");
    });
});

describe("logs", () => {
    test("reads 200 lines of the first ready pod unless it is told otherwise", () => {
        const call = parseCall({ action: "logs", ...POD }, settings);
        assert.deepEqual(call, { action: "logs", target: call.target, pod: undefined, container: undefined, tail: 200, sinceSeconds: undefined, previous: false });
    });

    test("takes a pod, a container, a tail, a window and the previous run", () => {
        const call = parseCall({ action: "logs", ...POD, pod: "orders-api-0", container: "orders-api", tail: 50, sinceSeconds: 90, previous: true }, settings);
        assert.deepEqual(call.action === "logs" && [call.pod, call.container, call.tail, call.sinceSeconds, call.previous], ["orders-api-0", "orders-api", 50, 90, true]);
    });

    test("a tail is 1 to 2000 lines", () => {
        for (const tail of [1, 2000]) assert.equal(parseCall({ action: "logs", ...POD, tail }, settings).action, "logs");
        for (const tail of [0, -5, 2001, 10.5, "200", Number.NaN, true]) {
            refused({ action: "logs", ...POD, tail }, /^k8s logs: tail must be a whole number from 1 to 2000 \(got /);
        }
    });

    test("a window is 1 second to a day", () => {
        for (const sinceSeconds of [1, 86_400]) assert.equal(parseCall({ action: "logs", ...POD, sinceSeconds }, settings).action, "logs");
        for (const sinceSeconds of [0, 86_401, 1.5, "60", -1]) {
            refused({ action: "logs", ...POD, sinceSeconds }, /^k8s logs: sinceSeconds must be a whole number from 1 to 86400 \(got /);
        }
    });

    test("a pod and a container are names, and never a flag", () => {
        for (const pod of ["orders-api-0", "orders-api-6d4f9c7b8-x2k9q", "a", "pod.with.dots"]) {
            assert.equal(parseCall({ action: "logs", ...POD, pod }, settings).action, "logs", pod);
        }
        for (const pod of ["", "-A", "--all-containers", "../x", "a b", "Pod", "a;b", "$(id)", "a/b", "x".repeat(254), 5]) {
            refused({ action: "logs", ...POD, pod }, /^k8s logs: pod must be a pod name, as pods shows it \(got /);
        }
        for (const container of ["", "-c", "--previous", "Main", "a b", "x".repeat(64), 5]) {
            refused({ action: "logs", ...POD, container }, /^k8s logs: container must be a container name \(got /);
        }
    });

    test("previous is true or false", () => {
        for (const previous of ["true", 1, "yes", []]) {
            refused({ action: "logs", ...POD, previous }, /^k8s logs: previous must be true or false \(got /);
        }
    });
});

describe("api", () => {
    const API = { action: "api", ...POD };

    test("takes a path, and the container and port from the configuration", () => {
        const call = parseCall({ ...API, path: "/actuator/health?x=1&y=2" }, settings);
        assert.deepEqual(call.action === "api" && [call.container, call.port, call.path, call.query], ["orders-api", 8080, "/actuator/health", "?x=1&y=2"]);
    });

    test("is GET only: no method, body or header can be given", () => {
        for (const extra of [{ method: "POST" }, { method: "GET" }, { body: { a: 1 } }, { data: "x" }, { headers: { a: "b" } }, { timeoutSec: 5 }]) {
            refused({ ...API, path: "/x", ...extra }, /^k8s api does not use /);
        }
    });

    test("needs a path", () => {
        refused({ ...API }, "k8s api needs path. Usage: k8s api {service, environment, path}");
    });

    test("a path is at most 400 characters of the usual set, one optional query, and no ..", () => {
        const good = ["/", "/x", "/a/b-c_d.e~f", "/a;b$c'(d)*+,=:@%20!&", "/x?y=1", "/x?", "/?a=b", `/${"a".repeat(400)}`, `/x?${"a".repeat(400)}`, "//double/slash", "/%e2%82%ac"];
        for (const path of good) assert.equal(parseCall({ ...API, path }, settings).action, "api", path);
        const bad = [
            "", "x", "x/y", "?a=1", " /x", "/x ", "/a b", "/a\nb", "/a\tb", "/a\u0000b", "/é", "/a\\b", "/a#b", "/a?b?c", "/a[0]", "/a{b}", "/a|b", "/a<b", '/a"b', "/a`b", "/a^b",
            `/${"a".repeat(401)}`, `/x?${"a".repeat(401)}`, "http://other.test/x", 5, null, undefined,
        ];
        for (const path of bad) {
            if (path === null || path === undefined) continue;
            refused({ ...API, path }, /^k8s api: path must start with \/ and hold only/);
        }
        refused({ ...API, path: null }, /^k8s api needs path\./);
    });

    test("a path that climbs is refused, however it is written", () => {
        const climbing = [
            "/..", "/a/../b", "/a/..", "/../etc", "/a..b", "/a/%2e%2e/b", "/a/%2E%2E/b", "/a/.%2e/b", "/a/%2e./b", "/a/%252e%252e/b", "/a/%25252e%25252e/b",
            "/a/%2525252e%2525252e/b", "/x?next=../y", "/x?next=%2e%2e", "/a/%252e./b", "/%2e%2e",
        ];
        for (const path of climbing) refused({ ...API, path }, /^k8s api: path must start with \//);
    });

    test("a path that is still changing after five rounds of decoding is refused", () => {
        // A dot written as %2e, then with its percent sign written as %25 again and again: four rounds of decoding
        // still leave a change to make, and a server that decodes that far would see "..".
        const nested = (depth: number) => `/a/%${"25".repeat(depth - 1)}2e`;
        refused({ ...API, path: nested(5) }, /^k8s api: path must start with \//);
        refused({ ...API, path: nested(9) }, /^k8s api: path must start with \//);
        assert.equal(parseCall({ ...API, path: nested(4) }, settings).action, "api", "a dot nested four deep settles, and is no climb");
        assert.equal(parseCall({ ...API, path: "/a/%2520b" }, settings).action, "api", "decoding settles after two rounds");
    });

    test("is refused in an environment jig-core always treats as production, and says where api works", () => {
        refused(
            { ...API, environment: "production", path: "/x" },
            "k8s api is refused in production (orders-api in production): it runs in test environments only; orders-api has it in staging",
        );
        const plain = load(withEntry("orders-api", "staging", { container: undefined, port: undefined }));
        refused({ ...API, environment: "production", path: "/x" }, "k8s api is refused in production (orders-api in production): it runs in test environments only", plain);
    });

    test("is refused when the configuration maps an environment to production, whatever the environment is called", () => {
        const mapped = load(section({ environments: { staging: "production" } }));
        refused({ ...API, path: "/x" }, /^k8s api is refused in production \(orders-api in staging\)/, mapped);
        const fine = load(section({ environments: { production: "prod" } }));
        assert.equal(parseCall({ ...API, path: "/x" }, fine).action, "api");
    });

    test("is refused when the environment has no container or port, and says what to add", () => {
        const message = 'k8s api: not set up for billing in staging: add "container" and "port" to its entry in the k8s section of jig.json';
        refused({ ...API, service: "billing", path: "/x" }, message);
        const noPort = load(withEntry("orders-api", "staging", { port: undefined }));
        refused({ ...API, path: "/x" }, /^k8s api: not set up for orders-api in staging/, noPort);
    });
});

describe("the usage lines", () => {
    test("name every parameter an action takes", () => {
        assert.equal(usage("pods"), "Usage: k8s pods {service, environment}");
        assert.equal(usage("status"), "Usage: k8s status {service, environment, waitFor?, timeoutSec?}");
        assert.equal(usage("logs"), "Usage: k8s logs {service, environment, pod?, container?, tail?, sinceSeconds?, previous?}");
        assert.equal(usage("api"), "Usage: k8s api {service, environment, path}");
    });
});
