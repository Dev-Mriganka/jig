// The watch that starts by itself. jig-git announces a push, and a pull request that was opened, as `jig-git:pushed`
// ({ repo, branch, sha, pr? }); jig-ops listens, and when a service of the catalog has that repository and a CI entry it
// starts a watch on the pushed commit. jig-git cannot import jig-ops, so this event is the whole contract between them.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PollOutcome } from "../../jig-core/src/contract.ts";
import { parsePushed, PUSHED_EVENT } from "../src/ci/autowatch.ts";
import { setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { gitlabCi, jenkinsCi, section, withCi } from "./support/section.ts";
import type { Raw } from "./support/section.ts";

let h: Harness;
beforeEach(() => {
    h = setupHarness();
});
afterEach(() => h.close());

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const SHA2 = "1234567abcdef0123456789abcdef0123456789a";
const pushed = (more: Record<string, unknown> = {}) => ({
    repo: "acme/orders-api",
    branch: "feature/one",
    sha: SHA,
    ...more,
});
const announce = (payload: unknown) => h.bus.publish("jig-git:pushed", payload);

describe("the listener", () => {
    test("listens to one channel, jig-git:pushed", () => {
        assert.deepEqual(h.bus.listening, ["jig-git:pushed"]);
        assert.equal(PUSHED_EVENT, "jig-git:pushed");
    });

    test("a push to a repository of the catalog starts a watch on the required checks of the pushed commit", () => {
        announce(pushed());
        assert.equal(h.jig.watches.length, 1);
        const [started] = h.jig.watches;
        assert.equal(started?.kind, "ops-ci");
        assert.equal(started?.title, `checks of branch feature/one at ${SHA.slice(0, 7)}`);
        assert.deepEqual(started?.spec, {
            system: "github-actions",
            service: "orders-api",
            branch: "feature/one",
            sha: SHA,
            finish: { kind: "required" },
        });
        assert.deepEqual([started?.timeoutMinutes, started?.stallMinutes], [60, 30]);
    });

    test("a pull request starts the watch on the pull request", () => {
        announce(pushed({ pr: 42 }));
        assert.equal(h.jig.watches[0]?.title, "checks of pull request 42");
        assert.equal((h.jig.watches[0]!.spec as { pr: number }).pr, 42);
    });

    test("a repository no service has starts nothing", () => {
        announce(pushed({ repo: "acme/unknown" }));
        assert.deepEqual(h.jig.watches, []);
    });

    test("a GitLab project in subgroups is found by its whole path, whatever the case", () => {
        const raw = withCi(gitlabCi({ project: "platform/payments/orders-api" }));
        ((raw.services as Record<string, Raw>)["orders-api"] as Raw).repo = "platform/payments/orders-api";
        h.configure(raw);
        announce(pushed({ repo: "Platform/Payments/Orders-API", pr: 12 }));
        assert.equal(h.jig.watches.length, 1);
        assert.deepEqual(h.jig.watches[0]?.spec, {
            system: "gitlab",
            service: "orders-api",
            ref: "feature/one",
            sha: SHA,
            finish: { kind: "pipeline" },
            since: h.clock.now(),
        });
        // The last two parts alone are another project.
        announce(pushed({ repo: "payments/orders-api" }));
        assert.equal(h.jig.watches.length, 1, "payments/orders-api is not platform/payments/orders-api");
    });

    test("a service with the repository but no ci entry starts nothing", () => {
        const raw = section();
        (raw.services as Record<string, Raw>).billing = {
            repo: "acme/billing",
            environments: { staging: { health: "https://b.example.test/h" } },
        };
        h.configure(raw);
        announce(pushed({ repo: "acme/billing" }));
        assert.deepEqual(h.jig.watches, []);
    });

    test("the repository is found whatever the case of its name, and every service that has it watches", () => {
        const raw = section();
        (raw.services as Record<string, Raw>)["orders-worker"] = {
            repo: "acme/orders-api",
            ci: { system: "github-actions" },
            environments: { staging: { health: "https://w.example.test/h" } },
        };
        h.configure(raw);
        announce(pushed({ repo: "ACME/Orders-API" }));
        assert.deepEqual(
            h.jig.watches.map((watch) => (watch.spec as { service: string }).service),
            ["orders-api", "orders-worker"],
        );
    });

    test("a newer push to the same branch replaces the watch of the older commit; another branch does not", () => {
        announce(pushed());
        announce(pushed({ branch: "feature/two" }));
        announce(pushed({ sha: SHA2 }));
        assert.deepEqual(
            h.jig.watches.map((watch) => watch.status),
            ["done", "open", "open"],
        );
        assert.equal((h.jig.watches[2]!.spec as { sha: string }).sha, SHA2);
    });

    test("a pull request opened after the push replaces the push's watch", () => {
        announce(pushed());
        announce(pushed({ pr: 77 }));
        assert.deepEqual(
            h.jig.watches.map((watch) => watch.status),
            ["done", "open"],
        );
        assert.equal(h.jig.watches[1]?.title, "checks of pull request 77");
    });

    test("a watch that ended on its own is not stopped again", () => {
        announce(pushed());
        h.jig.api.watches.stop("watch-1");
        announce(pushed({ sha: SHA2 }));
        assert.equal(h.jig.watches.length, 2);
        assert.deepEqual(
            h.jig.watches.map((watch) => watch.status),
            ["done", "open"],
        );
    });

    test("ops.watch.auto false starts nothing, and ops.watch sets the limits", () => {
        h.configure(section({ watch: { auto: false } }));
        announce(pushed());
        assert.equal(h.jig.watches.length, 0);
        h.configure(section({ watch: { timeoutMinutes: 15, stallMinutes: 5 } }));
        announce(pushed());
        assert.deepEqual([h.jig.watches[0]?.timeoutMinutes, h.jig.watches[0]?.stallMinutes], [15, 5]);
    });

    test("it starts no request: the commit is in the payload, so nothing is read from GitHub", () => {
        announce(pushed());
        assert.deepEqual(h.gh.calls(), []);
    });
});

describe("the watch it starts follows the CI system of the service", () => {
    test("GitLab CI: the pipeline of the commit, or the jobs the catalog requires", () => {
        h.configure(withCi(gitlabCi()));
        announce(pushed());
        assert.deepEqual(h.jig.watches[0]?.spec, {
            system: "gitlab",
            service: "orders-api",
            ref: "feature/one",
            sha: SHA,
            finish: { kind: "pipeline" },
            since: h.clock.now(),
        });
        assert.equal(h.jig.watches[0]?.title, `pipeline of branch feature/one at ${SHA.slice(0, 7)}`);
        h.configure(withCi(gitlabCi({ required: ["build", "unit"] })));
        announce(pushed({ sha: SHA2 }));
        assert.deepEqual((h.jig.watches[1]!.spec as { finish: unknown }).finish, {
            kind: "jobs",
            names: ["build", "unit"],
        });
    });

    test("Jenkins: the first build scheduled after the push, or the stages the catalog requires", () => {
        h.configure(withCi(jenkinsCi()));
        announce(pushed());
        assert.deepEqual(h.jig.watches[0]?.spec, {
            system: "jenkins",
            service: "orders-api",
            sha: SHA,
            finish: { kind: "build" },
            since: h.clock.now(),
        });
        assert.equal(h.jig.watches[0]?.title, "the next build of orders-api");
        h.configure(withCi(jenkinsCi({ required: ["Build"] })));
        announce(pushed({ sha: SHA2 }));
        assert.deepEqual((h.jig.watches[1]!.spec as { finish: unknown }).finish, { kind: "stages", names: ["Build"] });
    });
});

describe("what arrives on the bus is checked", () => {
    const bad: Array<[string, unknown]> = [
        ["nothing", undefined],
        ["a string", "acme/orders-api"],
        ["an array", [pushed()]],
        ["no repo", { branch: "main", sha: SHA }],
        ["a repo with a space", pushed({ repo: "acme/orders api" })],
        ["a repo without an owner", pushed({ repo: "orders-api" })],
        ["a repo with an empty part", pushed({ repo: "acme//orders-api" })],
        ["a repo with a step up in it", pushed({ repo: "acme/../orders-api" })],
        ["a repo with a part that is a dot", pushed({ repo: "platform/./orders-api" })],
        ["a repo with twenty-one parts", pushed({ repo: Array.from({ length: 21 }, (_, i) => `g${i}`).join("/") })],
        ["a repo longer than the catalog allows", pushed({ repo: `acme/${"a".repeat(200)}` })],
        ["a branch that starts with a dash", pushed({ branch: "--force" })],
        ["no branch", { repo: "acme/orders-api", sha: SHA }],
        ["a short sha", pushed({ sha: "abcdef0" })],
        ["a sha with letters past f", pushed({ sha: "z".repeat(40) })],
        ["a pull request that is not a number", pushed({ pr: "42" })],
        ["a pull request of zero", pushed({ pr: 0 })],
    ];
    for (const [label, payload] of bad) {
        test(`${label} starts nothing and breaks nothing`, () => {
            announce(payload);
            assert.deepEqual(h.jig.watches, []);
            assert.equal(parsePushed(payload), undefined);
        });
    }

    test("a repository of several parts is right, and so is a repository whose name starts with a dot", () => {
        for (const repo of ["platform/payments/orders-api", "a/b/c/d/e/f", "acme/.github"]) {
            assert.deepEqual(parsePushed(pushed({ repo })), pushed({ repo }), repo);
        }
    });

    test("a payload that is right is read as it is, with the pull request only when there is one", () => {
        assert.deepEqual(parsePushed(pushed()), pushed());
        assert.deepEqual(parsePushed({ ...pushed(), pr: 3, extra: "ignored" }), { ...pushed(), pr: 3 });
    });

    test("a catalog with errors starts nothing, and jig-core being gone breaks nothing", () => {
        h.configure({ nonsense: 1 });
        announce(pushed());
        assert.deepEqual(h.jig.watches, []);
        h.configure();
        h.jig.remove();
        assert.doesNotThrow(() => announce(pushed()));
        h.jig.publish();
        assert.deepEqual(h.jig.watches, []);
    });
});

describe("from a push to a result", () => {
    test("the watch that a push starts is polled by the kind and passes with the checks of the pushed commit", async () => {
        announce(pushed({ pr: 42 }));
        const spec = h.jig.watches[0]?.spec;
        const enc = encodeURIComponent;
        const api = (path: string, reply: Parameters<Harness["gh"]["on"]>[1]) => h.gh.on("api", reply, [`=${path}`]);
        api("repos/acme/orders-api/pulls/42", {
            json: { head: { sha: SHA }, base: { ref: "main" }, state: "open", merged: false, html_url: "u" },
        });
        api("repos/acme/orders-api", { json: { default_branch: "main" } });
        api(`repos/acme/orders-api/branches/${enc("main")}`, {
            json: { protection: { required_status_checks: { contexts: ["build"] } } },
        });
        api(`repos/acme/orders-api/rules/branches/${enc("main")}`, { json: [] });
        api(`repos/acme/orders-api/commits/${SHA}/status?per_page=100`, { json: { statuses: [] } });
        api(`repos/acme/orders-api/commits/${SHA}/check-runs?per_page=100`, {
            json: {
                total_count: 1,
                check_runs: [
                    {
                        id: 1,
                        name: "build",
                        status: "completed",
                        conclusion: "success",
                        html_url: "https://github.com/acme/orders-api/actions/runs/1/job/1",
                    },
                ],
            },
        });
        const kind = h.jig.kinds.get("ops-ci") as unknown as {
            poll(s: unknown, st: unknown, signal: AbortSignal): Promise<unknown>;
        };
        const { done } = (await kind.poll(spec, undefined, new AbortController().signal)) as PollOutcome<unknown>;
        assert.equal(done?.outcome, "passed");
        assert.equal(
            done?.summary,
            "Checks passed for pull request 42 at abcdef0: 1 pass, 0 fail, 0 pending, 0 skipped",
        );
    });
});
