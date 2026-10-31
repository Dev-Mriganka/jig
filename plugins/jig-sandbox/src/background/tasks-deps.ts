// What the registry of background tasks is given and asked: the things it needs from the plugin around it (`TasksDeps`), what starting
// a task takes (`StartRequest`) and what stopping one reports (`StopReport`). Types only, so tasks.ts is the registry and nothing else.
import type { Aftermath } from "../aftermath.ts";
import type { SandboxSettings } from "../config.ts";
import type { Sandbox } from "../sandbox.ts";
import type { SendOptions, Timing } from "./notify.ts";
import type { ProcessPort } from "./process.ts";
import type { NotifyOn, Task } from "./types.ts";

export interface TasksDeps {
    sandbox: Sandbox;
    aftermath: Aftermath;
    agentDir: () => string;
    settings: () => SandboxSettings["background"];
    /** Pi's environment, which a task starts from as a foreground command does. */
    env: NodeJS.ProcessEnv;
    /** The shell and its arguments that run a wrapped command, as Pi runs one. */
    shell: () => { shell: string; args: string[] };
    now?: () => number;
    /** `pi.sendMessage`. */
    send: (
        message: { customType: string; content: string; display: boolean; details: unknown },
        options: SendOptions,
    ) => void;
    /** `pi.events.emit`. */
    emit: (channel: string, data: unknown) => void;
    port?: ProcessPort;
    timing?: Partial<Timing>;
    graceMs?: number;
    /** Tests: a smaller log segment. */
    segmentBytes?: number;
    /** Tells the localhost bridge about a task starting and ending (`filtered` and `ask` modes). */
    bridge?: {
        taskStarted(task: Task): void;
        taskEnded(task: Task): void;
    };
}

export interface StartRequest {
    command: string;
    name?: string;
    notifyOn: NotifyOn;
    /** Seconds; cut to the longest run. Absent means the longest run. */
    timeoutSeconds?: number;
}

export interface StopReport {
    id: string;
    text: string;
}
