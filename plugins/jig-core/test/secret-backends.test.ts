// Secret backends a company plugin enables: it adds to what the user turned on, the user's `secrets.disabledBackends` turns
// any of them off, and without a company plugin the default stays `pass` alone.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { effectiveBackends } from "../src/config.ts";
import type { JigApi } from "../src/contract.ts";
import { start } from "./support/harness.ts";
import type { Harness, StartOptions } from "./support/harness.ts";
import { tempState } from "./support/state.ts";

const state = tempState();
const VARIABLE = "JIG_TEST_COMPANY_BACKEND";
beforeEach(() => {
    state.start();
    process.env[VARIABLE] = "the-value-from-env";
});

let h: Harness | undefined;
afterEach(async () => {
    await h?.shutdown();
    h = undefined;
    delete process.env[VARIABLE];
    state.stop();
});
async function begin(options: StartOptions = {}): Promise<Harness> {
    h = await start(options);
    return h;
}

/** Runs `/jig` and returns what it showed. */
async function jigStatus(harness: Harness): Promise<string> {
    const before = harness.ui.notifications.length;
    const command = harness.host.commands.get("jig");
    assert.ok(command, "/jig is registered");
    await command.handler("", harness.ctx as never);
    return harness.ui.notifications
        .slice(before)
        .map((entry) => entry.message)
        .join("\n");
}

const enable =
    (...backends: string[]) =>
    (api: JigApi): void =>
        api.config.enableSecretBackends(backends);

const refusal = async (api: JigApi, ref: string): Promise<string> => {
    try {
        await api.secrets.resolve(ref);
    } catch (error) {
        return (error as Error).message;
    }
    return "resolved";
};

describe("which backends are on", () => {
    test("without a company plugin only pass is, as it always was", async () => {
        const harness = await begin();
        assert.match(
            await refusal(harness.api, `env:${VARIABLE}`),
            /the env secret backend is not enabled: add "env" to secrets\.backends/,
        );
        assert.match(await jigStatus(harness), /^Secret backends on: pass$/m);
    });

    test("a company plugin turns one on for every user, and /jig says who did", async () => {
        const harness = await begin({ plugins: enable("env") });
        assert.equal(await harness.api.secrets.resolve(`env:${VARIABLE}`), "the-value-from-env");
        assert.match(await jigStatus(harness), /^Secret backends on: pass, env \(env enabled by a company plugin\)$/m);
    });

    test("it adds to a list of the user's, and it adds in whatever order plugins load", async () => {
        const harness = await begin({ config: { secrets: { backends: ["pass"] } }, plugins: enable("env", "cmd") });
        assert.equal(await harness.api.secrets.resolve(`env:${VARIABLE}`), "the-value-from-env");
        assert.match(
            await jigStatus(harness),
            /^Secret backends on: pass, env, cmd \(env, cmd enabled by a company plugin\)$/m,
        );
    });

    test("the user can turn one off, and the message says it was the user", async () => {
        const harness = await begin({
            config: { secrets: { disabledBackends: ["env"] } },
            plugins: enable("env", "file"),
        });
        assert.match(await refusal(harness.api, `env:${VARIABLE}`), /you turned it off in secrets\.disabledBackends/);
        assert.match(
            await jigStatus(harness),
            /^Secret backends on: pass, file \(file enabled by a company plugin\); turned off by you: env$/m,
        );
    });

    test("the user can turn off pass too, and a backend the user lists and turns off stays off", async () => {
        const harness = await begin({
            config: { secrets: { backends: ["pass", "env"], disabledBackends: ["pass", "env"] } },
        });
        assert.match(await jigStatus(harness), /^Secret backends on: none; turned off by you: pass, env$/m);
        assert.match(await refusal(harness.api, `env:${VARIABLE}`), /you turned it off/);
    });

    test("a name that is not a backend is a problem named company, and the good ones still apply", async () => {
        const harness = await begin({ plugins: enable("env", "vault", "env") });
        assert.equal(await harness.api.secrets.resolve(`env:${VARIABLE}`), "the-value-from-env");
        const status = await jigStatus(harness);
        assert.match(status, /company: secretBackends\[1\]: must be one of pass, env, keychain, op, cmd, file/);
        assert.match(status, /^Secret backends on: pass, env \(env enabled by a company plugin\)$/m);
    });

    test("a list that is not a list is a problem too", async () => {
        const harness = await begin({
            plugins: (api) => api.config.enableSecretBackends("env" as unknown as string[]),
        });
        assert.match(await jigStatus(harness), /company: secretBackends: must be a list of pass, env/);
        assert.match(await refusal(harness.api, `env:${VARIABLE}`), /not enabled/);
    });
});

describe("effectiveBackends", () => {
    const secrets = (backends: string[], disabledBackends: string[] = []) =>
        ({ backends, disabledBackends }) as Parameters<typeof effectiveBackends>[0];

    test("is the user's list and the company's, less what the user turned off", () => {
        assert.deepEqual(effectiveBackends(secrets(["pass"]), { secretBackends: ["env", "cmd"] }), {
            on: ["pass", "env", "cmd"],
            byCompany: ["env", "cmd"],
            off: [],
        });
        assert.deepEqual(effectiveBackends(secrets(["pass", "env"], ["cmd"]), { secretBackends: ["env", "cmd"] }), {
            on: ["pass", "env"],
            byCompany: [],
            off: ["cmd"],
        });
    });

    test("never lists a backend twice, and credits the company only for what the user did not list", () => {
        const result = effectiveBackends(secrets(["env", "env"]), { secretBackends: ["env", "file"] });
        assert.deepEqual(result.on, ["env", "file"]);
        assert.deepEqual(result.byCompany, ["file"]);
    });
});
