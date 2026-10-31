// Gates: checks other plugins register, asked about each call after the rules have decided. The whole point of the contract
// is what a gate cannot do, so most of these tests try to make one loosen a decision, or change what runs, and fail.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { CallClass, Gate, GateCall, GateVerdict, JigApi } from "../src/contract.ts";
import { createGates, frozenCall } from "../src/gates.ts";
import { start } from "./support/harness.ts";
import type { Harness, StartOptions } from "./support/harness.ts";
import { rawRecords, tempState } from "./support/state.ts";

const state = tempState();
beforeEach(() => state.start());
afterEach(() => state.stop());

let h: Harness | undefined;
afterEach(async () => {
    await h?.shutdown();
    h = undefined;
});
async function begin(options: StartOptions = {}): Promise<Harness> {
    h = await start(options);
    return h;
}

/** A tool whose calls say where they act and whether they write: `{ env, effect, action }`. */
function declare(api: JigApi, tool = "fake"): void {
    api.declareTool({
        tool,
        plugin: "jig-test",
        classify: (input): CallClass => ({
            ...(typeof input.action === "string" ? { action: input.action } : {}),
            environment: String(input.env ?? "local"),
            effect: input.effect === "write" ? "write" : "read",
        }),
    });
}

type Check = (call: GateCall, signal: AbortSignal) => GateVerdict | undefined | Promise<GateVerdict | undefined>;
function gate(check: Check, name = "test-gate"): Gate {
    return { name, plugin: "jig-test", check };
}

const PROD = { environments: { prod: { kind: "production" }, staging: { kind: "test" } } };
const ALLOW = { select: () => "Allow" };
const DECLINE = { select: () => "Decline" };

describe("registering a gate", () => {
    test("a gate needs a name, a plugin and a check, and says which is missing", async () => {
        const harness = await begin();
        const make = (over: Partial<Gate>) => () => harness.api.gates.register({ ...gate(() => undefined), ...over });
        assert.throws(make({ name: "" }), /needs a name/);
        assert.throws(make({ plugin: "" }), /plugin needs a name/);
        assert.throws(make({ check: "no" as never }), /check must be a function/);
        assert.throws(() => harness.api.gates.register(undefined as never), TypeError);
    });

    test("registering the same name again replaces the gate", async () => {
        const harness = await begin({ ui: false, plugins: (api) => declare(api) });
        harness.api.gates.register(gate(() => ({ decision: "deny", reason: "first" })));
        harness.api.gates.register(gate(() => undefined));
        assert.equal((await harness.call({ tool: "fake" })).blocked, false);
    });
});

describe("what a gate sees", () => {
    test("the tool, action, environment, effect and the decision so far, and the input and folder", async () => {
        const seen: GateCall[] = [];
        const harness = await begin({
            config: PROD,
            ui: false,
            cwd: "/work/project",
            plugins: (api) => {
                declare(api);
                api.gates.register(
                    gate((call) => {
                        seen.push(call);
                        return undefined;
                    }),
                );
            },
        });
        await harness.call({ id: "c1", tool: "fake", input: { action: "go", env: "staging", effect: "read", n: 1 } });
        const [call] = seen;
        assert.equal(call?.toolCallId, "c1");
        assert.equal(call?.tool, "fake");
        assert.equal(call?.action, "go");
        assert.equal(call?.environment, "staging");
        assert.equal(call?.environmentKind, "test");
        assert.equal(call?.effect, "read");
        assert.equal(call?.decision, "allow");
        assert.equal(call?.cwd, "/work/project");
        assert.deepEqual(call?.input, { action: "go", env: "staging", effect: "read", n: 1 });
        assert.deepEqual(call?.paths, []);
    });

    test("for write and edit, the absolute paths: as written, and with a link followed", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "jig-gate-paths-"));
        try {
            mkdirSync(path.join(root, "real"));
            symlinkSync(path.join(root, "real"), path.join(root, "link"));
            const seen: GateCall[] = [];
            const harness = await begin({
                ui: false,
                cwd: root,
                plugins: (api) =>
                    api.gates.register(
                        gate((call) => {
                            seen.push(call);
                            return undefined;
                        }),
                    ),
            });
            await harness.call({ tool: "write", input: { path: "link/a.txt", content: "x" } });
            await harness.call({ tool: "edit", input: { path: "real/../real/b.txt" } });
            await harness.call({ tool: "read", input: { path: "real/c.txt" } });
            assert.deepEqual(
                [...(seen[0]?.paths ?? [])].sort(),
                [path.join(root, "link", "a.txt"), path.join(root, "real", "a.txt")].sort(),
            );
            assert.deepEqual(seen[1]?.paths, [path.join(root, "real", "b.txt")]);
            assert.deepEqual(seen[2]?.paths, [], "a read has no paths: only write and edit are held by their files");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the call is frozen, and what runs is what the model sent", async () => {
        const failures: string[] = [];
        const ran: unknown[] = [];
        const harness = await begin({
            ui: false,
            plugins: (api) => {
                declare(api);
                api.gates.register(
                    gate((call) => {
                        for (const attempt of [
                            () => {
                                (call.input as Record<string, unknown>).effect = "read";
                            },
                            () => {
                                (call as unknown as Record<string, unknown>).decision = "allow";
                            },
                            () => (call.paths as string[]).push("/x"),
                            () => {
                                (call.input.nested as { deep: number }).deep = 2;
                            },
                        ]) {
                            try {
                                attempt();
                            } catch (error) {
                                failures.push((error as Error).name);
                            }
                        }
                        return undefined;
                    }),
                );
            },
        });
        const input = { effect: "write", nested: { deep: 1 } };
        await harness.call({ tool: "fake", input, run: () => void ran.push(structuredClone(input)) });
        assert.deepEqual(failures, ["TypeError", "TypeError", "TypeError", "TypeError"]);
        assert.deepEqual(ran, [{ effect: "write", nested: { deep: 1 } }]);
        assert.deepEqual(input, { effect: "write", nested: { deep: 1 } });
    });
});

describe("a gate can ask", () => {
    test("an allowed call asks, and runs only on yes; the question says who asked and why", async () => {
        const harness = await begin({
            ui: ALLOW,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "ask", reason: "the plan needs your eyes" }), "plans"));
            },
        });
        const outcome = await harness.call({ tool: "fake", input: { effect: "read" } });
        assert.equal(outcome.blocked, false);
        assert.equal(harness.ui.selects.length, 1);
        assert.match(harness.ui.selects[0]?.title ?? "", /Asked by plans: the plan needs your eyes/);
        const [decision] = harness.decisions();
        assert.equal(decision?.decision, "ask");
        assert.equal(decision?.source, "gate");
        assert.equal(decision?.gate, "plans");
        assert.equal(decision?.answer, "allow");
    });

    test("declining stops the call, with the user's reason", async () => {
        const harness = await begin({
            ui: { select: () => "Decline", input: () => "not yet" },
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "ask", reason: "look first" })));
            },
        });
        const outcome = await harness.call({ tool: "fake" });
        assert.equal(outcome.blocked, true);
        assert.match(outcome.reason ?? "", /declined this call, and said: not yet/);
    });

    test("a rule that allows the call, and an earlier session answer, cannot stand in: it asks every time", async () => {
        const harness = await begin({
            config: { rules: [{ tool: "fake", decision: "allow" }] },
            ui: { select: () => "Allow for this session" },
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "ask", reason: "every time" })));
            },
        });
        for (let n = 0; n < 3; n++) assert.equal((await harness.call({ tool: "fake" })).blocked, false);
        assert.equal(harness.ui.selects.length, 3, "an allow rule and 'for this session' did not answer for the gate");
    });

    test("a call that already asked asks once, not twice", async () => {
        const harness = await begin({
            ui: ALLOW,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "ask", reason: "also" })));
            },
        });
        assert.equal(
            (await harness.call({ tool: "fake", input: { env: "external", effect: "write" } })).blocked,
            false,
        );
        assert.equal(harness.ui.selects.length, 1);
        // The table asked, the gate agreed: the source is still the table's, and the gate is named.
        assert.equal(harness.decisions()[0]?.source, "table");
        assert.equal(harness.decisions()[0]?.gate, "test-gate");
    });

    test("with no screen to ask on, an ask is a deny", async () => {
        const harness = await begin({
            ui: false,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "ask", reason: "needs you" })));
            },
        });
        const outcome = await harness.call({ tool: "fake" });
        assert.equal(outcome.blocked, true);
        assert.match(outcome.reason ?? "", /there is no screen to ask on/);
        assert.equal(harness.records()[0]?.errorKind, "no-screen");
    });
});

describe("a gate can deny", () => {
    test("the call is blocked with the gate's reason and the tool never runs", async () => {
        let ran = false;
        const harness = await begin({
            ui: false,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "deny", reason: "held until the plan is approved" }), "wf"));
            },
        });
        const outcome = await harness.call({
            tool: "fake",
            input: { effect: "write" },
            run: () => void (ran = true),
        });
        assert.equal(outcome.blocked, true);
        assert.equal(outcome.reason, "Blocked by jig-core: held until the plan is approved");
        assert.equal(ran, false);
    });

    test("it is recorded as a gate's decision, and the record holds no reason", async () => {
        const harness = await begin({
            ui: false,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "deny", reason: "SECRET-LOOKING reason text" }), "wf"));
            },
        });
        await harness.call({ tool: "fake" });
        const [record] = harness.records();
        assert.equal(record?.decision, "deny");
        assert.equal(record?.decisionSource, "gate");
        assert.equal(record?.errorKind, "denied");
        assert.match(String(record?.error), /held by gate wf/);
        assert.ok(!rawRecords(harness.stateDir).includes("SECRET-LOOKING"));
        const [event] = harness.decisions();
        assert.equal(event?.source, "gate");
        assert.equal(event?.gate, "wf");
    });

    test("a reason is one line of plain text, cut short", async () => {
        const harness = await begin({
            ui: false,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "deny", reason: `a\nb\u001b[31mc${"x".repeat(900)}` })));
            },
        });
        const reason = (await harness.call({ tool: "fake" })).reason ?? "";
        assert.ok(!/[\u0000-\u001f]/.test(reason));
        assert.ok(reason.length < 560, `${reason.length} characters`);
    });
});

describe("a gate can never loosen a decision", () => {
    test("answering allow is no answer: a call that asks still asks, and one that is allowed stays allowed", async () => {
        const harness = await begin({
            ui: DECLINE,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "allow", reason: "go on" }) as unknown as GateVerdict));
            },
        });
        const asked = await harness.call({ tool: "fake", input: { env: "external", effect: "write" } });
        assert.equal(asked.blocked, true, "the table's ask was not turned into an allow");
        assert.equal(harness.ui.selects.length, 1);
    });

    test("a call the rules deny is final: the gate is not even asked", async () => {
        let asked = 0;
        const harness = await begin({
            config: { ...PROD, rules: [{ tool: "fake", environment: "staging", decision: "deny" }] },
            ui: ALLOW,
            plugins: (api) => {
                declare(api);
                api.gates.register(
                    gate(() => {
                        asked++;
                        return { decision: "allow" } as unknown as GateVerdict;
                    }),
                );
            },
        });
        assert.equal((await harness.call({ tool: "fake", input: { env: "staging", effect: "write" } })).blocked, true);
        assert.equal(asked, 0);
    });

    test("the floor stays: a write to production, and a protected path, are denied whatever a gate says", async () => {
        const harness = await begin({
            config: PROD,
            ui: ALLOW,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => ({ decision: "allow", reason: "fine" }) as unknown as GateVerdict));
            },
        });
        const prod = await harness.call({ tool: "fake", input: { env: "prod", effect: "write" } });
        assert.equal(prod.blocked, true);
        assert.match(prod.reason ?? "", /writes to production are never allowed/);
        const protectedPath = await harness.call({
            tool: "write",
            input: { path: path.join(harness.agentDir, "jig.json") },
        });
        assert.equal(protectedPath.blocked, true);
    });

    test("answers that are not ask or deny with a reason are ignored, reported once, and decide nothing", async () => {
        const answers: unknown[] = [
            "deny",
            42,
            { decision: "deny" },
            { decision: "deny", reason: "" },
            { decision: "maybe", reason: "x" },
            { decision: "allow", reason: "x" },
            null,
        ];
        const harness = await begin({
            ui: false,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(() => answers.shift() as GateVerdict | undefined, "odd"));
            },
        });
        for (let n = 0; n < 7; n++) assert.equal((await harness.call({ tool: "fake" })).blocked, false, `answer ${n}`);
        await harness.host.commands.get("jig")?.handler("", harness.ctx as never);
        const text = harness.ui.notifications.map((item) => item.message).join("\n");
        assert.equal(text.match(/gate "odd"/g)?.length, 1, "reported once, whatever the number of odd answers");
        assert.match(text, /answered with something that is not ask or deny/);
    });
});

describe("a gate that fails denies the call", () => {
    test("a throw", async () => {
        const harness = await begin({
            ui: false,
            plugins: (api) => {
                declare(api);
                api.gates.register(
                    gate(() => {
                        throw new Error("the state file is torn");
                    }, "wf"),
                );
            },
        });
        const outcome = await harness.call({ tool: "fake" });
        assert.equal(outcome.blocked, true);
        assert.match(
            outcome.reason ?? "",
            /^jig-core could not decide: gate "wf" \(jig-test\) failed: the state file is torn/,
        );
        assert.equal(harness.records()[0]?.errorKind, "internal");
    });

    test("a rejection", async () => {
        const harness = await begin({
            ui: false,
            plugins: (api) => {
                declare(api);
                api.gates.register(gate(async () => Promise.reject(new Error("nope"))));
            },
        });
        assert.equal((await harness.call({ tool: "fake" })).blocked, true);
    });

    test("taking too long, and the gate is told to stop", async () => {
        let aborted = false;
        const harness = await begin({
            ui: false,
            gateTimeoutMs: 30,
            plugins: (api) => {
                declare(api);
                api.gates.register(
                    gate(
                        (_call, signal) =>
                            new Promise(() => {
                                signal.addEventListener("abort", () => {
                                    aborted = true;
                                });
                            }),
                    ),
                );
            },
        });
        const outcome = await harness.call({ tool: "fake" });
        assert.equal(outcome.blocked, true);
        assert.match(outcome.reason ?? "", /failed: it took longer than/);
        assert.equal(aborted, true);
    });
});

describe("several gates", () => {
    async function strictest(order: readonly ("ask" | "deny")[]): Promise<{ reason?: string; asked: string[] }> {
        const asked: string[] = [];
        const harness = await begin({
            ui: ALLOW,
            plugins: (api) => {
                declare(api);
                for (const decision of order) {
                    api.gates.register(
                        gate(() => {
                            asked.push(decision);
                            return { decision, reason: `${decision} from ${decision}` };
                        }, decision),
                    );
                }
            },
        });
        const outcome = await harness.call({ tool: "fake" });
        assert.equal(outcome.blocked, true);
        return { ...(outcome.reason === undefined ? {} : { reason: outcome.reason }), asked };
    }

    test("the strictest answer wins when the ask comes first", async () => {
        const result = await strictest(["ask", "deny"]);
        assert.match(result.reason ?? "", /deny from deny/);
        assert.deepEqual(result.asked, ["ask", "deny"]);
    });

    test("and when the deny comes first, which ends the asking", async () => {
        const result = await strictest(["deny", "ask"]);
        assert.match(result.reason ?? "", /deny from deny/);
        assert.deepEqual(result.asked, ["deny"]);
    });

    test("/jig lists the gates and who registered them", async () => {
        const harness = await begin({ plugins: (api) => api.gates.register(gate(() => undefined, "wf")) });
        await harness.host.commands.get("jig")?.handler("", harness.ctx as never);
        assert.match(
            harness.ui.notifications.map((item) => item.message).join("\n"),
            /Gates \(they can only make a decision stricter\): wf \(jig-test\)/,
        );
    });
});

describe("the gate registry on its own", () => {
    const call = (over: Partial<GateCall> = {}): GateCall =>
        frozenCall({
            toolCallId: "c",
            tool: "t",
            environment: "local",
            environmentKind: "local",
            effect: "read",
            decision: "allow",
            input: {},
            cwd: "/",
            paths: [],
            ...over,
        });

    test("no gates, no answer", async () => {
        assert.equal(await createGates().check(call()), undefined);
    });

    test("it keeps registration order and replaces by name", () => {
        const gates = createGates();
        gates.register(gate(() => undefined, "a"));
        gates.register(gate(() => undefined, "b"));
        gates.register(gate(() => ({ decision: "deny", reason: "x" }), "a"));
        assert.deepEqual(
            gates.list().map((entry) => entry.name),
            ["a", "b"],
        );
    });

    test("a gate that returns a promise of nothing leaves the decision alone", async () => {
        const gates = createGates();
        gates.register(gate(async () => undefined));
        assert.equal(await gates.check(call()), undefined);
    });
});
