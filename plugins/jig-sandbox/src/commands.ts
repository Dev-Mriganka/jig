// The `/sandbox` commands:
//   /sandbox                       whether bash is sandboxed, and every rule with where it came from
//   /sandbox doctor                checks the requirements and proves the sandbox with real commands
//   /sandbox off, /sandbox on      for this session only
//   /sandbox allowed               the folders and hosts you allowed always or for this session
//   /sandbox allowed forget <x>    takes one back
//   /sandbox allowed add <x>       allows an ask-first folder, or a host in the ask network mode, without a question
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Allowed } from "./allowed.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { classifyHost } from "./network/addresses.ts";
import { parsePattern } from "./network/hosts.ts";
import { shown } from "./pathing.ts";
import type { OutsideRun } from "./outside.ts";
import type { Rule, RuleKind, RuleSet } from "./rules.ts";
import type { Sandbox } from "./sandbox.ts";

/** A list longer than this is shown in a scrollable selector instead of a notice. */
const NOTICE_LINES = 12;

export interface CommandDeps {
    sandbox: Sandbox;
    allowed: Allowed;
    platform: NodeJS.Platform;
    /** Called after `off` and `on`, to redraw the footer. */
    refresh(ctx: ExtensionCommandContext): void;
    /** The commands that ran outside the sandbox in this session, for `/sandbox` to list. */
    outsideRuns: OutsideRun[];
    lookupName?: string;
}

const KIND_TITLE: Record<RuleKind, string> = {
    hidden: "Hidden: never readable",
    locked: "Locked: readable, never written",
    "ask-first": "Ask first: writable once you say yes",
};

function ruleLine(rule: Rule): string {
    return `  ${rule.shown}   (${rule.source})   ${rule.reason}`;
}

/** The text of `/sandbox`: the state first, then every rule. */
export function statusLines(deps: CommandDeps, cwd: string): string[] {
    const { sandbox } = deps;
    const state = sandbox.state;
    const lines: string[] = [];
    switch (state.kind) {
        case "ready":
        case "starting":
            lines.push(
                `bash is sandboxed, network ${sandbox.mode}${sandbox.modeNote === undefined ? "" : ` (${sandbox.modeNote})`}`,
            );
            break;
        case "off":
            lines.push("bash is NOT sandboxed: you turned it off for this session (/sandbox on turns it back on)");
            break;
        case "unavailable":
            lines.push(`bash is REFUSED, the sandbox could not start: ${state.reason}`);
            lines.push(
                "  /sandbox doctor checks each requirement; /sandbox off runs bash without the sandbox for this session",
            );
            break;
        case "stopped":
            lines.push("the sandbox is not running (no session)");
            break;
    }
    lines.push(...networkLines(deps));
    if (sandbox.sessionDir !== undefined)
        lines.push(`  broker: process ${sandbox.pid ?? "none"}, session folder ${sandbox.sessionDir}`);
    const found = Object.entries(sandbox.programs.found).map(([name, place]) => `${name} ${place}`);
    if (found.length > 0) lines.push(`  programs: ${found.join("; ")}`);

    let rules: RuleSet | undefined;
    try {
        rules = sandbox.rulesFor(cwd);
    } catch (error) {
        lines.push(`  the rules could not be computed: ${(error as Error).message}`);
    }
    if (rules === undefined) return lines;
    for (const note of sandbox.notes) lines.push(`  ${note}`);
    for (const problem of rules.problems) lines.push(`  ${problem}`);
    const problem = deps.allowed.problem();
    if (problem !== undefined) lines.push(`  ${problem}`);

    for (const kind of ["hidden", "locked", "ask-first"] as const) {
        const of = rules.rules.filter((rule) => rule.kind === kind);
        lines.push("", `${KIND_TITLE[kind]} (${of.length}):`);
        for (const rule of of) lines.push(ruleLine(rule));
        if (kind === "locked" && rules.missing.length > 0) {
            lines.push(
                `  and ${rules.missing.length} more that are not on this machine now; if a command creates one, it is removed again`,
            );
        }
    }
    const allowedFolders = deps.allowed.folders();
    if (allowedFolders.length > 0) {
        lines.push("", "Allowed by you (writable although they ask first):");
        for (const folder of allowedFolders) lines.push(`  ${shown(folder, rules.home)}`);
    }
    const allowedHosts = deps.allowed.hosts();
    if (allowedHosts.length > 0) {
        lines.push("", "Hosts allowed by you (reachable without asking in the ask network mode):");
        for (const host of allowedHosts) lines.push(`  ${host}`);
    }
    lines.push("", "Writable:");
    for (const item of rules.writable) lines.push(`  ${item.shown}   (${item.source})`);
    if (rules.reopened.length > 0) {
        lines.push("", "Readable again although a rule hides the folder around them:");
        for (const item of rules.reopened) lines.push(`  ${item.shown}   (${item.source})`);
    }
    lines.push("", "Everything else under those folders is writable, as it is outside the sandbox.");
    lines.push(...outsideLines(deps.outsideRuns, rules.home));
    return lines;
}

/** What the network mode lets through, for the modes that filter. */
export function networkLines(deps: CommandDeps): string[] {
    const { sandbox } = deps;
    if (sandbox.mode !== "filtered" && sandbox.mode !== "ask") return [];
    const settings = sandbox.settings();
    const lines: string[] = [];
    if (sandbox.mode === "ask") {
        const allowed = [...settings.network.allow, ...deps.allowed.hosts()];
        lines.push(`  hosts allowed without asking: ${allowed.length === 0 ? "none yet" : allowed.join(", ")}`);
    }
    if (settings.network.deny.length > 0) lines.push(`  hosts refused: ${settings.network.deny.join(", ")}`);
    lines.push(
        `  ports on this machine commands may reach: ${settings.network.localhost.length === 0 ? "none" : settings.network.localhost.join(", ")}`,
    );
    const tasks = sandbox.bridge.forwarderPorts().filter((port) => !settings.network.localhost.includes(port));
    if (tasks.length > 0) lines.push(`  ports of background tasks carried into each command: ${tasks.join(", ")}`);
    const problem = sandbox.bridge.problem;
    if (problem !== undefined) lines.push(`  ${problem}`);
    return lines;
}

/** The commands that ran outside the sandbox this session, newest last, each with how it was allowed. */
export function outsideLines(runs: readonly OutsideRun[], home: string): string[] {
    if (runs.length === 0) return ["", "Run outside the sandbox this session: nothing"];
    const how = { once: "once", session: "this exact command, this session", rule: "by a rule" } as const;
    const lines = ["", `Run outside the sandbox this session (${runs.length}):`];
    for (const run of runs.slice(-20)) {
        const command = run.command.replace(/\s+/g, " ");
        lines.push(
            `  ${run.at.toISOString().slice(11, 19)}  ${command.length > 100 ? `${command.slice(0, 99)}...` : command}`,
        );
        lines.push(
            `            in ${shown(run.folder, home)}, allowed ${how[run.how]}; why: ${run.reason.replace(/\s+/g, " ").slice(0, 150)}`,
        );
    }
    if (runs.length > 20) lines.push(`  and ${runs.length - 20} earlier`);
    return lines;
}

async function show(ctx: ExtensionCommandContext, title: string, lines: string[]): Promise<void> {
    if (lines.length <= NOTICE_LINES) ctx.ui.notify(lines.join("\n"), "info");
    else await ctx.ui.select(title, lines);
}

export function registerSandboxCommand(pi: ExtensionAPI, deps: CommandDeps): void {
    pi.registerCommand("sandbox", {
        description: "jig-sandbox: whether bash is sandboxed, the rules, doctor, off and on, folders you allowed",
        getArgumentCompletions: (prefix) => {
            const matches = ["doctor", "off", "on", "allowed"].filter((word) => word.startsWith(prefix));
            return matches.length === 0 ? null : matches.map((word) => ({ value: word, label: word }));
        },
        handler: async (args, ctx) => {
            const [word, ...rest] = args.trim().split(/\s+/);
            const cwd = ctx.cwd || process.cwd();
            if (word === undefined || word === "") return show(ctx, "sandbox", statusLines(deps, cwd));
            if (word === "doctor") {
                ctx.ui.notify("Checking the sandbox: this runs a few real commands inside it...", "info");
                const lines = await runDoctor(deps.sandbox, {
                    cwd,
                    platform: deps.platform,
                    ...(deps.lookupName === undefined ? {} : { lookupName: deps.lookupName }),
                });
                return show(ctx, "sandbox doctor", formatDoctor(lines));
            }
            if (word === "off") {
                const changed = deps.sandbox.setEnabled(false);
                deps.refresh(ctx);
                ctx.ui.notify(
                    changed
                        ? "bash is no longer sandboxed for this session: it can read your credentials and write anywhere you can. /sandbox on turns it back on."
                        : `The sandbox is ${deps.sandbox.state.kind === "off" ? "already off" : "not running"}.`,
                    changed ? "warning" : "info",
                );
                return;
            }
            if (word === "on") {
                const changed = deps.sandbox.setEnabled(true);
                deps.refresh(ctx);
                const state = deps.sandbox.state;
                ctx.ui.notify(
                    changed
                        ? state.kind === "ready"
                            ? "bash is sandboxed again."
                            : `The sandbox is not available: ${state.kind === "unavailable" ? state.reason : state.kind}. bash stays refused; /sandbox doctor says what to fix.`
                        : "The sandbox is already on.",
                    changed && state.kind === "ready" ? "info" : "warning",
                );
                return;
            }
            if (word === "allowed") return allowed(deps, ctx, rest, cwd);
            ctx.ui.notify(
                "Usage: /sandbox, /sandbox doctor, /sandbox off, /sandbox on, /sandbox allowed [add <folder> | forget <folder>]",
                "info",
            );
        },
    });
}

async function allowed(deps: CommandDeps, ctx: ExtensionCommandContext, words: string[], cwd: string): Promise<void> {
    const [action, ...rest] = words;
    const target = rest.join(" ").trim();
    const home = deps.sandbox.rulesFor(cwd).home;
    if (action === undefined || action === "") {
        const kept = deps.allowed.always();
        const session = deps.allowed.session().filter((folder) => !kept.folders.includes(folder));
        const sessionHosts = deps.allowed.sessionHosts().filter((host) => !kept.hosts.includes(host));
        const list = (title: string, items: string[]): string =>
            items.length === 0 ? `${title}: nothing` : `${title}:\n${items.map((item) => `  ${item}`).join("\n")}`;
        const lines = [
            list(
                "Allowed always",
                kept.folders.map((folder) => shown(folder, home)),
            ),
            list(
                "Allowed for this session",
                session.map((folder) => shown(folder, home)),
            ),
            list("Hosts allowed always", kept.hosts),
            list("Hosts allowed for this session", sessionHosts),
            "/sandbox allowed forget <folder|host> takes one back; /sandbox allowed add <folder|host> allows an ask-first folder, or a host in the ask network mode.",
        ];
        return show(ctx, "sandbox allowed", lines.join("\n").split("\n"));
    }
    if (action === "forget") {
        if (target === "") return ctx.ui.notify("Usage: /sandbox allowed forget <folder|host>", "info");
        const removed = deps.allowed.forget(target.replace(/^~(?=\/)/, home));
        const names = [...removed.folders.map((folder) => shown(folder, home)), ...removed.hosts];
        ctx.ui.notify(
            names.length === 0
                ? `Nothing allowed matches ${target}. /sandbox allowed lists what is.`
                : `Forgot ${names.join(", ")}: it asks again.`,
            "info",
        );
        return;
    }
    if (action === "add") {
        if (target === "") return ctx.ui.notify("Usage: /sandbox allowed add <folder|host>", "info");
        if (
            !/^[/~]/.test(target) &&
            (target.includes(".") || target.startsWith("[")) &&
            parsePattern(target) !== undefined
        ) {
            return allowHost(deps, ctx, target);
        }
        const want = target.replace(/^~(?=\/)/, home);
        const rule = deps.sandbox
            .rulesFor(cwd)
            .rules.find(
                (candidate) => candidate.kind === "ask-first" && (candidate.path === want || candidate.named === want),
            );
        if (rule === undefined) {
            return ctx.ui.notify(
                `${target} is not a folder the sandbox asks about, or it is allowed already. /sandbox lists the ones it asks about.`,
                "warning",
            );
        }
        try {
            deps.allowed.allowAlways(rule.path);
            ctx.ui.notify(
                `Allowed writes to ${rule.shown}, always. /sandbox allowed forget ${rule.shown} takes it back.`,
                "info",
            );
        } catch (error) {
            deps.allowed.allowSession(rule.path);
            ctx.ui.notify(
                `Allowed writes to ${rule.shown} for this session only: it could not be kept (${(error as Error).message}).`,
                "warning",
            );
        }
        return;
    }
    ctx.ui.notify("Usage: /sandbox allowed [add <folder|host> | forget <folder|host>]", "info");
}

/** `/sandbox allowed add api.example.com[:443]`: a host the ask network mode lets through without asking. */
function allowHost(deps: CommandDeps, ctx: ExtensionCommandContext, target: string): void {
    const pattern = parsePattern(target);
    if (pattern === undefined) {
        ctx.ui.notify(`${target} is not a host such as api.example.com or *.example.com:443.`, "warning");
        return;
    }
    const kind = classifyHost(pattern.host);
    if (kind.kind === "ip" && kind.range !== undefined) {
        ctx.ui.notify(
            `${target} is an address the sandbox always refuses (${kind.range}); allowing it would change nothing. A port on this machine goes in sandbox.network.localhost.`,
            "warning",
        );
        return;
    }
    const note =
        deps.sandbox.mode === "ask" ? "" : ` It matters in the ask network mode; the mode now is ${deps.sandbox.mode}.`;
    try {
        deps.allowed.allowHostAlways(target);
        ctx.ui.notify(`Allowed ${target}, always. /sandbox allowed forget ${target} takes it back.${note}`, "info");
    } catch (error) {
        deps.allowed.allowHostSession(target);
        ctx.ui.notify(
            `Allowed ${target} for this session only: it could not be kept (${(error as Error).message}).${note}`,
            "warning",
        );
    }
}
