// How jig-core is told what each ci call does: its environment and whether it reads or writes. What may not run throws a
// TypeError, which jig-core takes to mean "invalid input" and blocks without asking anyone. Reads are external reads, rerun
// and trigger are external writes and so ask, and a watch is a local write. The CI host is `external` unless the catalog
// names the jig-core environment it is in.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { gitlabCi, jenkinsCi, withCi } from "./support/section.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

type Input = Record<string, unknown>;
type Said = { action?: string; environment: string; effect: string };

/** What the tool says about a call: its class, or the message of the TypeError that blocks it. */
function said(input: Input): Said | string {
    try {
        return h.ci.declaration.classify({ service: "orders-api", ...input }) as Said;
    } catch (error) {
        assert.ok(
            error instanceof TypeError,
            `${JSON.stringify(input)}: a refusal must be a TypeError, and was ${String(error)}`,
        );
        return error.message;
    }
}

const SYSTEMS: Array<[string, () => void]> = [
    ["GitHub Actions", () => h.configure()],
    ["GitLab CI", () => h.configure(withCi(gitlabCi()))],
    ["Jenkins", () => h.configure(withCi(jenkinsCi()))],
];

describe("reads are external reads", () => {
    for (const [label, use] of SYSTEMS) {
        test(`status, runs, run and log of ${label}`, () => {
            use();
            for (const action of ["status", "runs", "run", "log"]) {
                const extra = action === "run" ? { run_id: 1 } : {};
                assert.deepEqual(
                    said({ action, ...extra }),
                    { action, environment: "external", effect: "read" },
                    action,
                );
            }
        });
    }

    test("whatever the kind jig-core gives `external`", () => {
        for (const kind of ["external", "test", "production"] as const) {
            h.jig.setKinds({ external: kind });
            assert.deepEqual(
                said({ action: "status" }),
                { action: "status", environment: "external", effect: "read" },
                kind,
            );
        }
    });
});

describe("rerun and trigger are external writes, and so they ask", () => {
    test("rerun on GitHub Actions and GitLab, trigger on GitLab and Jenkins", () => {
        h.configure();
        assert.deepEqual(said({ action: "rerun", run_id: 1 }), {
            action: "rerun",
            environment: "external",
            effect: "write",
        });
        h.configure(withCi(gitlabCi()));
        assert.deepEqual(said({ action: "rerun", run_id: 1 }), {
            action: "rerun",
            environment: "external",
            effect: "write",
        });
        assert.deepEqual(said({ action: "trigger", ref: "main" }), {
            action: "trigger",
            environment: "external",
            effect: "write",
        });
        h.configure(withCi(jenkinsCi()));
        assert.deepEqual(said({ action: "trigger" }), { action: "trigger", environment: "external", effect: "write" });
    });

    test("a write to production is denied by the floor, before anyone is asked", async () => {
        h.configure(withCi({ system: "github-actions", environment: "production" }));
        const result = await h.ci.call({ service: "orders-api", action: "rerun", run_id: 1 });
        assert.equal(result.blocked, "Denied by the floor: a write to production");
        assert.equal(result.preview, undefined);
        assert.deepEqual(h.gh.calls(), []);
    });
});

describe("the CI host is external unless the catalog names an environment", () => {
    test("a named test environment: reads and writes are in it", () => {
        h.configure(withCi(gitlabCi({ environment: "staging" })));
        assert.deepEqual(said({ action: "status" }), { action: "status", environment: "staging", effect: "read" });
        assert.deepEqual(said({ action: "rerun", run_id: 1 }), {
            action: "rerun",
            environment: "staging",
            effect: "write",
        });
        assert.deepEqual(said({ action: "watch", branch: "main" }), {
            action: "watch",
            environment: "local",
            effect: "write",
        });
    });

    test("a name jig-core does not know counts as production, and writes there are denied", async () => {
        h.configure(withCi({ system: "github-actions", environment: "ci-farm" }));
        assert.deepEqual(said({ action: "status" }), { action: "status", environment: "ci-farm", effect: "read" });
        const result = await h.ci.call({ service: "orders-api", action: "rerun", run_id: 1 });
        assert.match(result.blocked ?? "", /^Denied by the floor/);
    });
});

describe("a watch is a local write", () => {
    for (const [label, use] of SYSTEMS) {
        test(`on ${label}: it starts something on this machine and asks nobody`, () => {
            use();
            const where = label === "Jenkins" ? {} : { branch: "main" };
            assert.deepEqual(said({ action: "watch", ...where }), {
                action: "watch",
                environment: "local",
                effect: "write",
            });
        });
    }
});

describe("an action an adapter does not have is invalid input, and the message names the adapter", () => {
    test("GitHub Actions has no trigger", () => {
        h.configure();
        assert.equal(
            said({ action: "trigger", ref: "main" }),
            "ci trigger: GitHub Actions (orders-api) does not support trigger. It supports: status, runs, run, log, rerun, watch",
        );
    });

    test("Jenkins has no rerun", () => {
        h.configure(withCi(jenkinsCi()));
        assert.equal(
            said({ action: "rerun", run_id: 1 }),
            "ci rerun: Jenkins (orders-api) does not support rerun. It supports: status, runs, run, log, trigger, watch",
        );
    });

    test("GitLab CI has every action, but not every variant: no rerun of everything, no GitHub-only finish line", async () => {
        h.configure(withCi(gitlabCi()));
        assert.equal(said({ action: "status" }) instanceof Object, true);
        const all = await h.ci.call({ service: "orders-api", action: "rerun", run_id: 1, failed_only: false });
        assert.match(all.blocked ?? all.error?.message ?? "", /GitLab CI retries the failed jobs of a pipeline only/);
        const merged = await h.ci.call({ service: "orders-api", action: "watch", branch: "main", finish: "merged" });
        assert.match(
            merged.error?.message ?? merged.blocked ?? "",
            /GitLab CI does not support finish merged\. It supports: required, check, run/,
        );
    });

    test("a refused call runs nothing and asks nobody", async () => {
        h.configure();
        const result = await h.ci.call({ service: "orders-api", action: "trigger", ref: "main" });
        assert.match(
            result.blocked ?? "",
            /^Blocked by jig-core: ci cannot run with this input: ci trigger: GitHub Actions/,
        );
        assert.equal(result.preview, undefined);
        assert.deepEqual(h.gh.calls(), []);
    });
});

describe("a call with the wrong shape is refused with the usage line", () => {
    test("an unknown service, or one without a ci entry, names the ones there are", () => {
        assert.equal(
            said({ action: "status", service: "nope" }),
            'ci: no service named "nope". Services with a ci entry: orders-api (github-actions)',
        );
        assert.match(
            said({ action: "status", service: "billing" }) as string,
            /^ci: billing has no ci entry in the catalog\. Services with a ci entry: orders-api/,
        );
        assert.match(
            said({ action: "status", service: undefined }) as string,
            /^ci status needs service\. Services with a ci entry: orders-api \(github-actions\)$/,
        );
    });

    test("a missing or unknown action", () => {
        assert.match(
            said({}) as string,
            /^ci needs action: status, runs, run, log, rerun, trigger, watch\. Usage: ci \{action, service, \.\.\.\}/,
        );
        assert.match(
            said({ action: "delete" }) as string,
            /^ci: action must be one of status, runs, run, log, rerun, trigger, watch \(got "delete"\)/,
        );
    });

    test("a parameter the action does not take, for this adapter", () => {
        assert.equal(
            said({ action: "runs", run_id: 3 }),
            "ci runs: GitHub Actions (orders-api) does not take run_id. Usage: ci runs {service, branch?, sha?, state?, limit?}",
        );
        h.configure(withCi(jenkinsCi()));
        assert.equal(
            said({ action: "status", branch: "main" }),
            "ci status: Jenkins (orders-api) does not take branch. Usage: ci status {service, run_id?}",
        );
        h.configure(withCi(gitlabCi()));
        assert.match(
            said({ action: "status", number: 4 }) as string,
            /^ci status: GitLab CI \(orders-api\) does not take number\./,
        );
    });

    test("a missing parameter", () => {
        assert.equal(said({ action: "run" }), "ci run needs run_id. Usage: ci run {service, run_id}");
        assert.equal(
            said({ action: "rerun" }),
            "ci rerun needs run_id. Usage: ci rerun {service, run_id, failed_only?}",
        );
        h.configure(withCi(gitlabCi()));
        assert.equal(
            said({ action: "trigger" }),
            "ci trigger needs ref. Usage: ci trigger {service, ref, parameters?}",
        );
    });

    test("a value that breaks a limit", () => {
        assert.match(
            said({ action: "runs", limit: 51 }) as string,
            /^ci runs: limit must be a whole number from 1 to 50 \(got 51\)/,
        );
        assert.match(
            said({ action: "log", run_id: 1, tail: 401 }) as string,
            /tail must be a whole number from 1 to 400/,
        );
        assert.match(said({ action: "log", run_id: 1, grep: "(" }) as string, /grep is not a valid regular expression/);
        assert.match(said({ action: "status", branch: "--force" }) as string, /branch must be a branch or tag name/);
        assert.match(
            said({ action: "status", sha: "xyz" }) as string,
            /sha must be a commit id of 4 to 64 hexadecimal digits/,
        );
        assert.match(said({ action: "run", run_id: 0 }) as string, /run_id must be a whole number/);
        h.configure(withCi(gitlabCi()));
        assert.match(
            said({ action: "trigger", ref: "main", parameters: { "bad name": "x" } }) as string,
            /parameters: "bad name" is not a usable name/,
        );
        assert.match(
            said({ action: "trigger", ref: "main", parameters: { A: "x\ny" } }) as string,
            /parameters\.A must be one line/,
        );
        assert.match(
            said({
                action: "trigger",
                ref: "main",
                parameters: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`P${i}`, "x"])),
            }) as string,
            /at most 20 names/,
        );
    });
});

describe("without a usable catalog", () => {
    test("the tool says ops is not set up and does nothing", () => {
        h.configure({ nonsense: 1 });
        assert.match(said({ action: "status" }) as string, /^ops is not set up/);
    });
});
