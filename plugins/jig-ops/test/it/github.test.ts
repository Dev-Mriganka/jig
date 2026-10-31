// jig-ops' `ci` tool, GitHub Actions adapter, reading this repository's own workflow runs through the real `gh` and the real
// GitHub API, with the token Actions gives the run (`GH_TOKEN`) and the permissions the job names: read only. Nothing is rerun and
// nothing is written. The run that is reading is itself in progress, so it is the run to look at.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { describeIt, must, optional } from "../../../../test/support/it.ts";
import { ok } from "../support/harness.ts";
import type { Harness } from "../support/harness.ts";
import { realHarness, run } from "../support/real.ts";
import type { Raw } from "../support/section.ts";

describeIt(
    "jig-ops ci against GitHub Actions",
    {
        service: "github-actions",
        variables: ["JIG_IT_GITHUB_REPOSITORY", "JIG_IT_GITHUB_RUN_ID"],
        hint: "gh signed in (GH_TOKEN), the repository as owner/name and the id of one of its runs",
    },
    () => {
        const repository = () => must("JIG_IT_GITHUB_REPOSITORY");
        const runId = () => Number(must("JIG_IT_GITHUB_RUN_ID"));

        const section = (): Raw => ({
            services: {
                jig: {
                    repo: repository(),
                    ci: { system: "github-actions", workflow: optional("JIG_IT_GITHUB_WORKFLOW") ?? "ci.yml" },
                    environments: { staging: { health: "https://staging.example.test/health" } },
                },
            },
        });
        // The token Actions gives the run. Without one, gh uses its own sign-in, as it does for a person.
        const harness = (t: TestContext, token = optional("GH_TOKEN")): Harness =>
            realHarness(t, section(), token === undefined ? {} : { GH_TOKEN: token });
        const jig = { service: "jig" };

        /** What a call to GitHub the test makes itself answers, with the same token. */
        const api = (path: string, jq: string): string => run("gh", ["api", path, "--jq", jq]).trim();

        test("runs lists this repository's workflow runs, and the one that is reading is among them", async (t) => {
            const h = harness(t);
            const result = await h.ci.call({ action: "runs", ...jig, limit: 50 });
            const text = ok(result);
            assert.deepEqual(result.cls, { action: "runs", environment: "external", effect: "read" });
            assert.match(text, new RegExp(`^${repository().replace(/[./]/g, "\\$&")}: \\d+ runs?\\n`));
            const mine = text.split("\n").find((line) => line.startsWith(`#${runId()} `));
            assert.ok(mine, `run ${runId()} is in the list:\n${text.slice(0, 600)}`);
            assert.match(mine, /^#\d+ +\S+ +.+ [0-9a-f]{7} +\S+ +\d{4}-\d\d-\d\dT\d\d:\d\d$/);
            assert.ok(Array.isArray((result.details as { ids?: unknown }).ids));
        });

        test("run shows the jobs of a run, and its artifacts", async (t) => {
            const h = harness(t);
            const text = ok(await h.ci.call({ action: "run", ...jig, run_id: runId() }));
            assert.match(
                text,
                new RegExp(`^Run #${runId()} .+: \\S+\\n\\S+ at [0-9a-f]{7}, \\S+; https://github\\.com/`),
            );
            assert.match(text, /\n\S+ +.+ \(job \d+\)/);
            assert.match(text, /\nArtifacts: /);
        });

        test("status counts the checks of a commit", async (t) => {
            const h = harness(t);
            const sha = api(`repos/${repository()}/actions/runs/${runId()}`, ".head_sha");
            const text = ok(await h.ci.call({ action: "status", ...jig, sha }));
            assert.match(text, new RegExp(`^commit ${sha.slice(0, 7)}: `));
            assert.match(text, /\d+ (pass|fail|pending|skipped)/);
        });

        test("log reads a job's log, capped and scrubbed, from a run that has ended", async (t) => {
            const h = harness(t);
            const finished = await h.ci.call({ action: "runs", ...jig, state: "completed", limit: 5 });
            const ids = (finished.details as { ids?: number[] }).ids ?? [];
            if (ids.length === 0) {
                t.skip("no run of this workflow has ended yet");
                return;
            }
            // A job of that run, by its id, as `run` lists it.
            const jobs = ok(await h.ci.call({ action: "run", ...jig, run_id: ids[0] }));
            const job = /\(job (\d+)\)/.exec(jobs)?.[1];
            assert.ok(job, jobs);
            const text = ok(await h.ci.call({ action: "log", ...jig, run_id: ids[0], job, tail: 30 }));
            assert.match(text, new RegExp(`^Run #${ids[0]}, job .+ \\(\\S+\\): `));
            assert.ok(text.split("\n").length > 5, "lines of the log follow");
            assert.ok(text.split("\n").length <= 40, "the tail was honoured");
        });

        test("a run that does not exist is one line naming the call and the status", async (t) => {
            const h = harness(t);
            const result = await h.ci.call({ action: "run", ...jig, run_id: 1 });
            assert.match(result.error?.message ?? "", /^gh run view failed: .*(HTTP 404|Could not resolve|not found)/i);
        });

        test("a token GitHub does not accept is told as a sign-in problem, and the token is not repeated", async (t) => {
            const bogus = "not-a-real-token";
            const h = harness(t, bogus);
            const result = await h.ci.call({ action: "runs", ...jig });
            const message = result.error?.message ?? "";
            assert.match(message, /gh is not signed in: run gh auth login yourself/);
            assert.ok(!message.includes(bogus));
        });

        test("what the tool reads is a read: nothing is asked, and the adapter has no way to write here", async (t) => {
            const h = harness(t);
            const inputs: Array<[string, Record<string, unknown>]> = [
                ["runs", { ...jig }],
                ["run", { ...jig, run_id: runId() }],
                ["status", { ...jig, sha: "abcd1234" }],
                ["log", { ...jig, run_id: runId() }],
            ];
            for (const [action, input] of inputs) {
                const cls = h.ci.declaration.classify({ action, ...input });
                assert.deepEqual(cls, { action, environment: "external", effect: "read" }, action);
            }
            const trigger = await h.ci.call({ action: "trigger", ...jig });
            assert.match(trigger.blocked ?? "", /github[- ]actions/i);
        });
    },
);
