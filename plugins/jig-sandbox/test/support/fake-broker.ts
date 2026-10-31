// A broker that does not sandbox: it answers like the real one and hands the command back as it was given, so the plugin's
// own work (rules, environment, output, explanations, lifecycle) can be tested on any machine.
import type { Broker, BrokerEvent, BrokerLaunch } from "../../src/broker-client.ts";

export interface FakeBrokerLog {
    launches: BrokerLaunch[];
    requests: Array<{ type: string; fields: Record<string, unknown> }>;
    stops: number;
    brokers: Broker[];
}

export interface FakeBrokerOptions {
    /** Rejects the request of this type. */
    failOn?: string;
    /** What `finish` reports as the runtime's network refusals. */
    violations?: Array<{ line: string }>;
}

export function fakeBrokers(options: FakeBrokerOptions = {}): {
    start: (launch: BrokerLaunch) => Promise<Broker>;
    log: FakeBrokerLog;
    /** Sends an event as the running broker would. */
    emit(event: BrokerEvent): void;
} {
    const log: FakeBrokerLog = { launches: [], requests: [], stops: 0, brokers: [] };
    const listeners: Array<(event: BrokerEvent) => void> = [];
    return {
        log,
        emit(event) {
            for (const listener of listeners) listener(event);
        },
        async start(launch) {
            log.launches.push(launch);
            let alive = true;
            const exits: Array<(code: number | null) => void> = [];
            const broker: Broker = {
                pid: 4242 + log.brokers.length,
                get alive() {
                    return alive;
                },
                async request(type, fields = {}) {
                    log.requests.push({ type, fields });
                    if (options.failOn === type) throw new Error(`fake broker refuses ${type}`);
                    if (type === "wrap") return { wrapped: String(fields.command) } as never;
                    if (type === "finish") return { violations: options.violations ?? [] } as never;
                    return {} as never;
                },
                async stop() {
                    if (!alive) return;
                    alive = false;
                    log.stops++;
                    for (const listener of exits) listener(0);
                },
                onExit(listener) {
                    exits.push(listener);
                },
                onEvent(listener) {
                    listeners.push(listener);
                },
                stderrTail: () => "",
            };
            log.brokers.push(broker);
            return broker;
        },
    };
}
