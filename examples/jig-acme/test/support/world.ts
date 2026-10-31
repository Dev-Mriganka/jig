// The world a company plugin runs in, as Pi builds it: the real jig-core, every built Jig plugin, and jig-acme, loaded into the fake
// Pi that jig-core's own tests use, with a jig.json written to a temporary agent folder. So a test of the company's defaults goes
// through exactly the registrations the plugins make (their section checks, and the keys that replace the company's instead of
// merging into it), and not a copy of them kept here.
//
// Nothing outside the temporary folders is touched: Pi's agent folder and Jig's state folder are made new, and the sandbox is
// loaded for what it registers but told that its platform is not one it supports, so that no test starts a real sandbox.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import apiPlugin from "../../../../plugins/jig-api/src/index.ts";
import { jig } from "../../../../plugins/jig-core/src/client.ts";
import type { JigApi } from "../../../../plugins/jig-core/src/contract.ts";
import { jigCore } from "../../../../plugins/jig-core/src/index.ts";
import { fakeContext, fakePi } from "../../../../plugins/jig-core/test/support/fake-pi.ts";
import type { FakePi } from "../../../../plugins/jig-core/test/support/fake-pi.ts";
import type { FakeUiLog } from "../../../../plugins/jig-core/test/support/fakes.ts";
import gitPlugin from "../../../../plugins/jig-git/src/index.ts";
import jiraPlugin from "../../../../plugins/jig-jira/src/index.ts";
import lensPlugin from "../../../../plugins/jig-lens/src/index.ts";
import logsPlugin from "../../../../plugins/jig-logs/src/index.ts";
import memoryPlugin from "../../../../plugins/jig-memory/src/index.ts";
import mongoPlugin from "../../../../plugins/jig-mongo/src/index.ts";
import opsPlugin from "../../../../plugins/jig-ops/src/index.ts";
import reviewPlugin from "../../../../plugins/jig-review/src/index.ts";
import { sandbox } from "../../../../plugins/jig-sandbox/src/index.ts";
import themePlugin from "../../../../plugins/jig-theme/src/index.ts";
import { jigAcme } from "../../src/index.ts";
import type { JigAcmeOptions } from "../../src/index.ts";

export interface World {
    host: FakePi;
    api: JigApi;
    ctx: ExtensionContext;
    ui: FakeUiLog;
    /** Pi's agent folder, where jig.json is. */
    agentDir: string;
    stateDir: string;
    /** The lines `/jig` shows (or, with `rules`, `/jig rules`). */
    jigLines(argument?: string): Promise<string[]>;
    /** Everything jig-core says is wrong with the configuration, as `/jig` shows it. */
    problems(): Promise<string[]>;
    /** Writes `personal` as jig.json and starts the session again. */
    restart(personal: unknown): Promise<void>;
    close(): Promise<void>;
}

export interface WorldOptions {
    /** The user's jig.json. Default: no file. */
    personal?: unknown;
    /** Which plugins load: jig-core and jig-acme always, the other Jig plugins unless `plugins` is false. */
    plugins?: boolean;
    /** Load jig-acme before jig-core, as Pi does when the package list puts it first. */
    acmeFirst?: boolean;
    acme?: JigAcmeOptions;
    /** Leave jig-acme out, to see what a call looks like without the company's additions. Default: true. */
    company?: boolean;
    /** What the fake screen answers when jig-core asks the user: an option of the question, or nothing (a declined question). */
    answer?: string;
}

/** Every built Jig plugin except jig-core, as Pi loads them. jig-workflow and jig-agents are designs. */
function jigPlugins(): ExtensionFactory[] {
    return [
        // Told its platform is not supported, so it registers its section and its tools and starts nothing.
        sandbox({ platform: "freebsd" as NodeJS.Platform }),
        memoryPlugin,
        gitPlugin,
        lensPlugin,
        jiraPlugin,
        logsPlugin,
        apiPlugin,
        opsPlugin,
        reviewPlugin,
        mongoPlugin,
        themePlugin,
    ] as ExtensionFactory[];
}

const SAVED = ["JIG_STATE_DIR", "PI_CODING_AGENT_DIR"] as const;

/**
 * jig-core's fake Pi has the calls jig-core makes. The other plugins make a few more (jig-lens draws an entry, jig-theme reads the
 * thinking level), and none of them matters to what these tests look at, so a missing one is given a stand-in that does nothing.
 */
function completed(pi: ExtensionAPI): ExtensionAPI {
    const stand = pi as unknown as Record<string, unknown>;
    for (const name of ["registerEntryRenderer", "appendEntry", "sendUserMessage", "registerMessageRenderer"]) {
        stand[name] ??= () => undefined;
    }
    stand.getThinkingLevel ??= () => "off";
    return pi;
}

export async function startWorld(options: WorldOptions = {}): Promise<World> {
    const root = mkdtempSync(path.join(tmpdir(), "jig-acme-"));
    const saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(root, "state");
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.JIG_STATE_DIR = stateDir;
    const write = (personal: unknown): void => {
        if (personal !== undefined) writeFileSync(path.join(agentDir, "jig.json"), JSON.stringify(personal));
    };
    write(options.personal);

    const host = fakePi();
    completed(host.pi);
    const acme = jigAcme(options.acme);
    const company = options.company !== false;
    if (company && options.acmeFirst === true) acme(host.pi as ExtensionAPI);
    jigCore()(host.pi);
    if (options.plugins !== false) for (const plugin of jigPlugins()) await plugin(host.pi);
    if (company && options.acmeFirst !== true) acme(host.pi as ExtensionAPI);

    const { ctx, log } = fakeContext({ ui: { select: () => options.answer }, mode: "rpc" });
    // The same for the session: jig-memory reads the branch of the conversation when a session starts.
    (ctx.sessionManager as unknown as Record<string, unknown>).getBranch = () => [];
    await host.fire("session_start", { reason: "startup" }, ctx);

    async function jigLines(argument = ""): Promise<string[]> {
        const command = host.commands.get("jig");
        if (command === undefined) throw new Error("the /jig command is not registered");
        const notices = log.notifications.length;
        const selects = log.selects.length;
        await command.handler(argument, ctx as never);
        return [
            ...log.notifications.slice(notices).flatMap((item) => item.message.split("\n")),
            ...log.selects.slice(selects).flatMap((item) => item.options),
        ];
    }

    return {
        host,
        api: jig(),
        ctx,
        ui: log,
        agentDir,
        stateDir,
        jigLines,
        async problems() {
            const lines = await jigLines();
            const from = lines.findIndex((line) => line.startsWith("Configuration problems"));
            return from === -1 ? [] : lines.slice(from + 1).map((line) => line.trim());
        },
        async restart(personal) {
            write(personal);
            await host.fire("session_start", { reason: "reload" }, ctx);
        },
        async close() {
            await host.fire("session_shutdown", { reason: "quit" }, ctx);
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            rmSync(root, { recursive: true, force: true });
        },
    };
}
