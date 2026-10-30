// The checks on a deploy call: its shape and its values, above all the version, the one text of a call that reaches a command
// line. Every refusal is a TypeError (invalid input) whose message says how to put the call right.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readOps } from "../src/catalog.ts";
import type { Catalog } from "../src/catalog.ts";
import { DEFAULT_WATCH_MINUTES, MAX_WATCH_MINUTES, parseCall, usage, VERSION } from "../src/deploy/params.ts";
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
const WHERE = { service: "orders-api", environment: "staging" };
/** A call of this action with everything it needs, and nothing it does not use. */
const base = (action: string, where: Record<string, unknown> = WHERE) => ({ action, ...where, ...(["plan", "run", "watch"].includes(action) ? { version: "1.4.3" } : {}) });

/** Asserts that a call is refused as invalid input, with a message that matches. */
function refused(input: Record<string, unknown>, message: RegExp | string, on: Catalog = catalog): void {
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
            () => parseCall({ action: "status", ...WHERE }, undefined),
            (error: unknown) => error instanceof TypeError && error.message === 'ops is not set up: add an "ops" section with "services" to jig.json (/jig lists configuration problems)',
        );
    });

    test("an action is needed, and is one of five", () => {
        refused({ ...WHERE }, /^deploy needs action: plan, run, status, rollback, watch\. Usage: deploy \{action, service, environment, \.\.\.\}/);
        refused({ action: "delete", ...WHERE }, /^deploy: action must be one of plan, run, status, rollback, watch \(got "delete"\)\. Usage: /);
        for (const action of ["undeploy", "scale", "restart", "apply", "install", "upgrade", "Run", 5, ["run"], {}]) {
            refused({ action, ...WHERE, version: "1.4.3" }, /^deploy: action must be one of plan, run, status, rollback, watch/);
        }
    });

    test("a call names its service and its environment, and the version where the action needs one", () => {
        refused({ action: "status", environment: "staging" }, /^deploy status needs service\. Known services: orders-api \(staging, production\), billing \(staging\)\. Usage: deploy status \{service, environment\}$/);
        refused({ action: "run", service: "billing" }, "deploy run needs environment, version. Usage: deploy run {service, environment, version}");
        refused({ action: "plan", ...WHERE }, "deploy plan needs version. Usage: deploy plan {service, environment, version}");
        refused({ action: "watch", ...WHERE }, "deploy watch needs version. Usage: deploy watch {service, environment, version, timeoutMinutes?}");
    });

    test("a parameter the action does not use is refused, with the usage line of that action", () => {
        refused({ action: "status", ...WHERE, version: "1.4.3" }, "deploy status does not use version. Usage: deploy status {service, environment}");
        refused({ action: "rollback", ...WHERE, version: "1.4.3" }, "deploy rollback does not use version. Usage: deploy rollback {service, environment}");
        refused({ action: "run", ...WHERE, version: "1.4.3", timeoutMinutes: 5 }, "deploy run does not use timeoutMinutes. Usage: deploy run {service, environment, version}");
    });

    test("no call can name a release, a chart, a values file, a value, an image, a context, a namespace, a flag or a verb", () => {
        const names = [
            "release", "chart", "valuesFile", "values", "set", "image", "tag", "repository", "workload", "container", "method", "context", "namespace",
            "kubeContext", "kubeconfig", "revision", "wait", "timeout", "dryRun", "force", "verb", "args", "command", "flags", "argv", "namespaceOverride",
        ];
        for (const action of ["plan", "run", "status", "rollback", "watch"]) {
            for (const name of names) {
                refused({ ...base(action), [name]: "value" }, new RegExp(`^deploy ${action} does not use ${name}\\.`));
            }
        }
    });

    test("null counts as not given, as models often send null for a field they do not use", () => {
        const call = parseCall({ action: "watch", ...WHERE, version: "1.4.3", timeoutMinutes: null }, catalog);
        assert.equal(call.action === "watch" && call.timeoutMinutes, DEFAULT_WATCH_MINUTES);
        refused({ action: "status", ...WHERE, version: null, service: null }, /^deploy status needs service\./);
        refused({ action: "run", ...WHERE, version: null }, /^deploy run needs version\./);
    });

    test("an unknown service or environment lists the known ones, led by the tool", () => {
        refused({ action: "status", service: "nope", environment: "staging" }, 'deploy: no service named "nope". Known services: orders-api (staging, production), billing (staging)');
        refused({ action: "status", service: "orders-api", environment: "qa" }, 'deploy: orders-api has no environment "qa". Known environments: staging, production');
    });

    test("an environment with no Kubernetes runtime has no rollout to read, for any action", () => {
        const onlyAddress = load({ services: { svc: { environments: { staging: { health: "https://svc.example.test/health" } } } } });
        for (const action of ["plan", "run", "status", "rollback", "watch"]) {
            refused(base(action, { service: "svc", environment: "staging" }), `deploy ${action}: svc in staging has no Kubernetes runtime in the catalog, so there is no rollout to read`, onlyAddress);
        }
    });

    test("hands on the environment and the Kubernetes target the catalog names", () => {
        const call = parseCall({ action: "run", service: "billing", environment: "staging", version: "2.0.0" }, catalog);
        assert.equal(call.env.deploy?.method, "kubectl-image");
        assert.equal(call.target.namespace, "billing-staging");
        assert.equal(call.target.context, "test-cluster");
    });
});

describe("the version", () => {
    const run = (version: unknown) => parseCall({ action: "run", ...WHERE, version }, catalog);

    test("is an image tag: 1 to 128 letters, digits, underscores, dots and dashes, not starting with a dot or a dash", () => {
        const good = ["1.4.3", "v1.4.3", "0.0.0-pr-feature-abc-1f2e3d4", "sha-abcdef0", "1.4.3_rc1", "latest", "7", "_x", "a.b-c_d", "A", "a".repeat(128), "1-", "1."];
        for (const version of good) assert.equal(run(version).action === "run" && run(version).action, "run", version);
        for (const version of good) assert.equal(VERSION.test(version), true, version);
    });

    test("is never something helm or kubectl could read as a flag, a second argument, a digest or an address", () => {
        const bad = [
            "", "-1", "--set", "-f", "--force", ".hidden", "..", "1.4.3 ", " 1.4.3", "1 4", "a b", "x:y", "x/y", "x@sha256:abc", "a;b", "a&&b", "a|b", "$(id)", "`id`", "a\nb",
            "a\u0000b", "a,b", "a=b", "image.tag=x", "a\\b", "é", "a'b", 'a"b', "a".repeat(129), 5, true, ["1.4.3"], {}, null,
        ];
        for (const version of bad) {
            if (version === null) continue;
            refused({ action: "run", ...WHERE, version }, /^deploy run: version must be an image tag of 1 to 128 characters \(letters, digits, \. _ -, not starting with \. or -\) \(got /);
        }
        refused({ action: "run", ...WHERE, version: null }, /^deploy run needs version\./);
    });

    test("is checked for plan and watch too", () => {
        for (const action of ["plan", "watch"]) {
            refused({ action, ...WHERE, version: "--set x=y" }, new RegExp(`^deploy ${action}: version must be an image tag`));
        }
    });

    test("is a stricter thing than what runtime rollout waits for, which is only read", () => {
        assert.equal(VERSION.test("1.4.3+build.5"), false, "a plus sign is no part of an image tag");
    });
});

describe("watch", () => {
    test("watches 15 minutes unless it is told otherwise, and at most two hours", () => {
        const plain = parseCall({ action: "watch", ...WHERE, version: "1.4.3" }, catalog);
        assert.equal(plain.action === "watch" && plain.timeoutMinutes, 15);
        for (const timeoutMinutes of [1, 30, MAX_WATCH_MINUTES]) {
            assert.equal(parseCall({ action: "watch", ...WHERE, version: "1.4.3", timeoutMinutes }, catalog).action === "watch", true);
        }
        for (const timeoutMinutes of [0, -1, MAX_WATCH_MINUTES + 1, 1.5, "15", true, Number.NaN, Infinity]) {
            refused({ action: "watch", ...WHERE, version: "1.4.3", timeoutMinutes }, /^deploy watch: timeoutMinutes must be a whole number from 1 to 120 \(got /);
        }
    });
});

describe("environments that are not deployed to", () => {
    test("are still planned, watched and read: the refusal is for run and rollback, and comes from the kind of the environment", () => {
        const noMethod = load(withEnvironment("orders-api", "staging", { deploy: undefined }));
        for (const action of ["plan", "status", "watch"]) {
            assert.equal(parseCall(base(action), noMethod).action, action);
        }
    });
});

describe("the usage lines", () => {
    test("name every parameter an action takes", () => {
        assert.equal(usage("plan"), "Usage: deploy plan {service, environment, version}");
        assert.equal(usage("run"), "Usage: deploy run {service, environment, version}");
        assert.equal(usage("status"), "Usage: deploy status {service, environment}");
        assert.equal(usage("rollback"), "Usage: deploy rollback {service, environment}");
        assert.equal(usage("watch"), "Usage: deploy watch {service, environment, version, timeoutMinutes?}");
    });
});
