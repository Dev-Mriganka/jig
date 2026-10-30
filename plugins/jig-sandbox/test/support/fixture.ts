// A machine for the rules and the explanations to look at: a Linux home with a project in it, and a session folder.
import { computeRules } from "../../src/rules.ts";
import type { RuleSet, RulesInput } from "../../src/rules.ts";
import { fakeMachine } from "./fake-files.ts";
import type { FakeMachine, MachineSpec } from "./fake-files.ts";

export const HOME = "/home/me";
export const CWD = `${HOME}/work/orders`;
export const SESSION = "/tmp/jig-sandbox-1000/abc";

/** A Linux machine with the folders every test needs. */
export function linux(spec: MachineSpec = {}): FakeMachine {
    return fakeMachine({
        dirs: [HOME, CWD, "/tmp", SESSION, `${SESSION}/tmp`, `${SESSION}/broker`, ...(spec.dirs ?? [])],
        files: spec.files ?? {},
        links: spec.links ?? {},
    });
}

export function input(files: FakeMachine, over: Partial<RulesInput> = {}): RulesInput {
    return {
        platform: "linux",
        wsl: false,
        home: HOME,
        uid: 1000,
        cwd: CWD,
        agentDir: `${HOME}/.pi/agent`,
        tmp: ["/tmp"],
        sessionDir: `${SESSION}/broker`,
        sessionTmp: `${SESSION}/tmp`,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        runtimePaths: [],
        protectedPaths: [],
        settings: { share: [], hide: [], lock: [] },
        approved: [],
        createdByAgent: new Set(),
        files,
        ...over,
    };
}

export const rules = (files: FakeMachine, over: Partial<RulesInput> = {}): RuleSet => computeRules(input(files, over));
