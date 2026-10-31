// What the agent sees of background tasks: `bash` gains `background`, `name` and `notifyOn`, and three tools read and stop
// the tasks. The idea (a flag on Pi's own bash plus output, list and kill tools) is adapted from gvanderclay/pi-bg-bash (MIT,
// see docs/background.md, "Credit"); the meaning of the parameters is this plugin's own.
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatMinutes, slashed, taskLine } from "./format.ts";
import { readOutput } from "./output.ts";
import { screenPatterns } from "./patterns.ts";
import type { Tasks } from "./tasks.ts";

const NAME = /^[\w .:/-]{1,40}$/;

/** The text a task-related tool answers with. */
const text = (value: string, details?: unknown) => ({
    content: [{ type: "text" as const, text: value }],
    details,
});

export const BACKGROUND_PARAMETER =
    "Start the command as a background task and return its id at once. Use it for a dev server, a watcher or a build that takes more than a minute. " +
    "You are woken when it ends or a notifyOn pattern matches, so never sleep or poll. The task is sandboxed like any command, and `timeout` is how long it may run at most.";
export const NAME_PARAMETER = "With background: a label for lists and messages, up to 40 characters.";
export const NOTIFY_PARAMETER =
    "With background: patterns that wake you besides the task ending. ready: what it prints when it is up; error: what it prints when it failed. " +
    "JavaScript regular expressions without slashes, case-sensitive, matched against one line at a time, up to 5 of each. " +
    "Back-references, look-behinds and a repeat inside a repeat are refused.";

function patternList(description: string) {
    return Type.Optional(Type.Array(Type.String(), { description, maxItems: 5 }));
}

/** The parameters that `bash` gains. */
export function backgroundProperties() {
    return {
        background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAMETER })),
        name: Type.Optional(Type.String({ maxLength: 40, description: NAME_PARAMETER })),
        notifyOn: Type.Optional(
            Type.Object(
                {
                    ready: patternList("Matches when the command is up, such as `Listening on` or `ready in \\d+ ms`."),
                    error: patternList("Matches when it failed, such as `ERROR|Exception|FAILED`."),
                },
                { description: NOTIFY_PARAMETER },
            ),
        ),
    };
}

/** What is wrong with the background parameters of a `bash` call, as a sentence for the agent, or undefined. */
export function backgroundProblem(params: {
    background?: boolean;
    outside?: boolean;
    name?: unknown;
    notifyOn?: unknown;
}): string | undefined {
    if (params.background !== true) {
        if (params.notifyOn !== undefined) return "notifyOn applies to a background task: add background: true.";
        if (params.name !== undefined) return "name applies to a background task: add background: true.";
        return undefined;
    }
    if (params.outside === true) {
        return "a background task cannot run outside the sandbox: run the command in the foreground with outside: true, or run it in the sandbox.";
    }
    const notify = params.notifyOn as { ready?: unknown; error?: unknown } | undefined;
    for (const kind of ["ready", "error"] as const) {
        const problem = screenPatterns(kind, notify?.[kind]);
        if (problem !== undefined) return problem;
    }
    if (params.name !== undefined) {
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (name !== "" && !NAME.test(name)) {
            return "name must be up to 40 characters from letters, digits, space and . : / _ -";
        }
    }
    return undefined;
}

/** Starts `bash`'s command as a task and answers as the design says. */
export async function startBackground(
    tasks: Tasks,
    params: { command: string; timeout?: number; name?: string; notifyOn?: { ready?: string[]; error?: string[] } },
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
) {
    if (ctx?.mode === "print" || ctx?.mode === "json") {
        throw new Error("Background tasks need an interactive Pi session: run the command in the foreground.");
    }
    if (signal?.aborted) throw new Error("aborted");
    if (params.timeout !== undefined && !(Number.isFinite(params.timeout) && params.timeout > 0)) {
        throw new Error("timeout must be a number of seconds above 0.");
    }
    const notifyOn = { ready: params.notifyOn?.ready ?? [], error: params.notifyOn?.error ?? [] };
    const name = typeof params.name === "string" ? params.name.trim() : undefined;
    tasks.setContext(ctx);
    const task = await tasks.start(
        {
            command: params.command,
            ...(name === undefined || name === "" ? {} : { name }),
            notifyOn,
            ...(params.timeout === undefined ? {} : { timeoutSeconds: params.timeout }),
        },
        ctx,
    );
    const wakes = [
        "exit",
        ...notifyOn.ready.map((pattern) => `ready ${slashed(pattern)}`),
        ...notifyOn.error.map((pattern) => `error ${slashed(pattern)}`),
    ];
    return text(
        `Started background task ${task.id} "${task.name}" (sandboxed, at most ${formatMinutes(Math.max(1, Math.round(task.timeoutMs / 60_000)))}).\n` +
            `Wakes you on: ${wakes.join("; ")}.\n` +
            `Read its output with bg_output {"id":"${task.id}","tail":40}. Do not sleep or poll.`,
        { id: task.id },
    );
}

type AnyTool = ToolDefinition<never, never, never>;

/** `bg_output`, `bg_list` and `bg_kill`. */
export function backgroundTools(tasks: Tasks): AnyTool[] {
    const output = {
        name: "bg_output",
        label: "bg_output",
        description:
            "Read the output of a background bash task. By default the lines not read yet; tail N gives the last N lines (1 to 500); offset reads forward from a byte offset (the footer names the next one); filter keeps only the lines that contain this text, ignoring case. Output is capped.",
        promptSnippet: "Read the output of a background task",
        promptGuidelines: [
            "For a dev server, watcher or long build, call bash with background: true and notifyOn, and never sleep or poll bg_output to wait: you are woken. After a wake, read only what you need with bg_output tail or filter.",
        ],
        parameters: Type.Object({
            id: Type.String({ description: "The task id that bash returned" }),
            tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "The last N lines" })),
            offset: Type.Optional(Type.Integer({ minimum: 0, description: "Read forward from this byte offset" })),
            filter: Type.Optional(
                Type.String({
                    maxLength: 200,
                    description: "Keep only the lines that contain this text, ignoring case",
                }),
            ),
        }),
        async execute(
            _id: string,
            params: { id: string; tail?: number; offset?: number; filter?: string },
            _signal: AbortSignal | undefined,
            _update: unknown,
            ctx: ExtensionContext,
        ) {
            tasks.setContext(ctx);
            if (params.tail !== undefined && params.offset !== undefined)
                throw new Error("tail and offset are exclusive.");
            const task = tasks.requireTask(params.id);
            const result = readOutput(
                task,
                {
                    ...(params.tail === undefined ? {} : { tail: params.tail }),
                    ...(params.offset === undefined ? {} : { offset: params.offset }),
                    ...(params.filter ? { filter: params.filter } : {}),
                },
                Date.now(),
            );
            if (result.range) tasks.notifier.seen(task.id, result.range.start, result.range.end);
            return text(result.text);
        },
    };
    const list = {
        name: "bg_list",
        label: "bg_list",
        description:
            "List this session's background bash tasks: id, state, run time, name, command, and whether the ready and error patterns matched.",
        promptSnippet: "List background tasks",
        parameters: Type.Object({}),
        async execute(
            _id: string,
            _params: unknown,
            _signal: AbortSignal | undefined,
            _update: unknown,
            ctx: ExtensionContext,
        ) {
            tasks.setContext(ctx);
            const all = tasks.list();
            const now = Date.now();
            return text(
                all.length === 0
                    ? "No background tasks."
                    : all
                          .map(
                              (task) =>
                                  taskLine(task, now) + (task.log?.error ? ` | log stopped (${task.log.error})` : ""),
                          )
                          .join("\n"),
            );
        },
    };
    const kill = {
        name: "bg_kill",
        label: "bg_kill",
        description:
            'Stop a background bash task, or all of them with id "all": a polite stop, three seconds, then a hard one. No wake-up follows.',
        promptSnippet: "Stop a background task",
        parameters: Type.Object({ id: Type.String({ description: 'The task id, or "all"' }) }),
        async execute(
            _id: string,
            params: { id: string },
            _signal: AbortSignal | undefined,
            _update: unknown,
            ctx: ExtensionContext,
        ) {
            tasks.setContext(ctx);
            const reports = await tasks.kill(params.id, "by agent");
            return text(reports.length === 0 ? "No running background tasks." : reports.map((r) => r.text).join("\n"));
        },
    };
    return [output, list, kill] as unknown as AnyTool[];
}
