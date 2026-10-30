// A stand-in for jig-core's run-time API, published on the same process-wide slot, so the plugin runs as it would under
// jig-core. Only what jig-logs uses is real: tool declarations, the `logs` section, secrets, sign-in services,
// transports and facts. Each behaves as jig-core's does where it matters to this plugin:
//   - a section that fails its check reads as undefined;
//   - an unknown secret reference, sign-in service or transport is an error that never repeats what was asked;
//   - a transport that throws is reported as `transport "<name>" failed: ...`.
// Every credential the fake hands out is remembered in `issued`, so a test can check that none of them reaches an error
// or a result.
import { publishJig, withdrawJig } from "../../../jig-core/src/client.ts";
import type {
    Facts,
    JigApi,
    SignInRequest,
    SignInService,
    ToolDeclaration,
    Transport,
    TransportRequest,
    TransportResponse,
} from "../../../jig-core/src/contract.ts";

export interface FakeJig {
    api: JigApi;
    declared: Map<string, ToolDeclaration>;
    /** The check each plugin registered for its section. */
    sections: Map<string, (raw: unknown) => readonly string[]>;
    /** What `config.section(name)` reads. Set with `setSection`. */
    setSection(name: string, value: unknown): void;
    /** Secret values by reference. */
    secrets: Map<string, string>;
    /** Every reference asked for, in order. */
    resolved: string[];
    /** Makes every secret lookup take this long. */
    secretDelayMs: number;
    signInServices: Map<string, SignInService>;
    /** Every request a sign-in service was asked to sign in. */
    signedIn: SignInRequest[];
    /** Every credential value handed out: secrets and sign-in headers. */
    issued: Set<string>;
    /** The transports plugins registered, and the requests sent through them. */
    transports: Map<string, Transport>;
    sent: TransportRequest[];
    facts: Map<string, Facts[]>;
    /** Every text or value the plugin asked jig-core to mask. jig-core masks results itself, so this stays empty. */
    masked: unknown[];
    remove(): void;
}

export function installFakeJig(): FakeJig {
    const declared = new Map<string, ToolDeclaration>();
    const sections = new Map<string, (raw: unknown) => readonly string[]>();
    const values = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    const resolved: string[] = [];
    const signInServices = new Map<string, SignInService>();
    const signedIn: SignInRequest[] = [];
    const issued = new Set<string>();
    const transports = new Map<string, Transport>();
    const sent: TransportRequest[] = [];
    const facts = new Map<string, Facts[]>();
    const masked: unknown[] = [];
    const state = { secretDelayMs: 0 };

    const wait = (ms: number, signal: AbortSignal | undefined) =>
        new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener(
                "abort",
                () => {
                    clearTimeout(timer);
                    reject(signal.reason);
                },
                { once: true },
            );
        });

    const api: JigApi = {
        version: 1,
        declareTool: (declaration) => void declared.set(declaration.tool, declaration),
        approvedPreview: () => undefined,
        addFacts: (id, added) => void facts.set(id, [...(facts.get(id) ?? []), added]),
        setTicket: () => {},
        secrets: {
            async resolve(reference, signal) {
                resolved.push(reference);
                if (state.secretDelayMs > 0) await wait(state.secretDelayMs, signal);
                const value = secrets.get(reference);
                // Like jig-core, the error does not repeat the reference.
                if (value === undefined) throw new Error("the secret could not be resolved");
                issued.add(value);
                return value;
            },
        },
        transports: {
            register: (name, transport) => void transports.set(name, transport),
            async request(name, request, signal): Promise<TransportResponse> {
                const transport = transports.get(name);
                if (transport === undefined) throw new Error(`no transport named "${name}"`);
                sent.push(request);
                try {
                    const response = await transport.request(request, signal);
                    return { ...response, headers: response.headers ?? {} };
                } catch (error) {
                    throw new Error(
                        `transport "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            },
        },
        signIn: {
            register: (name, service) => void signInServices.set(name, service),
            async headers(name, request, signal) {
                const service = signInServices.get(name);
                if (service === undefined) throw new Error(`no sign-in service is named "${name}"`);
                signedIn.push(request);
                const headers = await service.headers(request, signal);
                for (const value of Object.values(headers)) issued.add(value);
                return headers;
            },
        },
        mask: {
            text: (input) => (masked.push(input), input),
            value: (input) => (masked.push(input), input),
        },
        watches: {
            registerKind: () => {},
            start: () => "w1",
            list: () => [],
            stop: () => false,
        },
        config: {
            addEnvironments: () => {},
            addRules: () => {},
            addClassifyRules: () => {},
            addMaskFields: () => {},
            registerSection: (name, validate) => void sections.set(name, validate),
            section: (name) => {
                const value = values.get(name);
                const validate = sections.get(name);
                return value !== undefined && (validate === undefined || validate(value).length === 0)
                    ? value
                    : undefined;
            },
        },
        exec: {
            run: async () => {
                throw new Error("jig-logs starts no programs");
            },
            git: async () => {
                throw new Error("jig-logs starts no programs");
            },
        },
    };

    publishJig(api);
    return {
        api,
        declared,
        sections,
        setSection: (name, value) => void values.set(name, value),
        secrets,
        resolved,
        get secretDelayMs() {
            return state.secretDelayMs;
        },
        set secretDelayMs(ms: number) {
            state.secretDelayMs = ms;
        },
        signInServices,
        signedIn,
        issued,
        transports,
        sent,
        facts,
        masked,
        remove: () => withdrawJig(api),
    };
}
