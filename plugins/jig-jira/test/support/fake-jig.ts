// A stand-in for jig-core's run-time API, published on the same process-wide slot, so the plugin runs as it would under
// jig-core. Only what jig-jira uses is real: the section of jig.json, secrets, sign-in services, transports, the approved
// preview and the facts. Everything the plugin tells jig-core or asks of it is recorded for the tests.
import { publishJig, withdrawJig } from "../../../jig-core/src/client.ts";
import { createHttp } from "../../../jig-core/src/kit/http.ts";
import type {
    Facts,
    JigApi,
    Preview,
    SignInRequest,
    ToolDeclaration,
    Transport,
    TransportRequest,
    TransportResponse,
} from "../../../jig-core/src/contract.ts";

export interface FakeJig {
    api: JigApi;
    declared: Map<string, ToolDeclaration>;
    /** The check each plugin registered for its section of jig.json. */
    sections: Map<string, (raw: unknown) => readonly string[]>;
    /** The preview the user approved for a call that asked, by tool call id. */
    approved: Map<string, Preview>;
    facts: Map<string, Facts[]>;
    /** Secret values by reference. Every reference resolved is recorded. */
    secrets: Map<string, string>;
    secretCalls: string[];
    /** Sign-in services by name: the headers for a request. Every request asked about is recorded. */
    signIn: Map<string, (request: SignInRequest) => Record<string, string>>;
    signInCalls: Array<{ name: string; request: SignInRequest }>;
    /** Transports by name. Every request sent through one is recorded, as the transport received it. */
    transports: Map<string, Transport>;
    transportCalls: Array<{ name: string; request: TransportRequest }>;
    /** The network that `http.request` uses for a direct request. Default: the global `fetch`. */
    setFetch(fetchImpl: typeof fetch | undefined): void;
    /** What `config.section(name)` returns once the section passes its check, as at jig-core's session start. */
    setSection(name: string, value: unknown): void;
    /** Makes this the jig-core that plugins reach. Only one can be: a test with two fakes calls this before it uses either. */
    publish(): void;
    reset(): void;
    remove(): void;
}

/** What jig-core does with a transport's answer: it checks the shape, and names the header fields in lower case. */
function checked(value: TransportResponse): TransportResponse {
    return {
        status: value.status,
        headers: Object.fromEntries(Object.entries(value.headers).map(([name, text]) => [name.toLowerCase(), text])),
        body: value.body,
    };
}

export function installFakeJig(): FakeJig {
    const declared = new Map<string, ToolDeclaration>();
    const sections = new Map<string, (raw: unknown) => readonly string[]>();
    const values = new Map<string, unknown>();
    const approved = new Map<string, Preview>();
    const facts = new Map<string, Facts[]>();
    const secrets = new Map<string, string>();
    const secretCalls: string[] = [];
    const signIn = new Map<string, (request: SignInRequest) => Record<string, string>>();
    const signInCalls: FakeJig["signInCalls"] = [];
    const transports = new Map<string, Transport>();
    const transportCalls: FakeJig["transportCalls"] = [];
    let fetchImpl: typeof fetch | undefined;

    const api: JigApi = {
        version: 1,
        declareTool: (declaration) => void declared.set(declaration.tool, declaration),
        approvedPreview: (id) => approved.get(id),
        addFacts: (id, added) => void facts.set(id, [...(facts.get(id) ?? []), added]),
        setTicket: () => {},
        secrets: {
            resolve: async (ref) => {
                secretCalls.push(ref);
                const value = secrets.get(ref);
                if (value === undefined) throw new Error("the secret could not be read: no such entry");
                return value;
            },
        },
        signIn: {
            register: () => {},
            headers: async (name, request) => {
                signInCalls.push({ name, request });
                const service = signIn.get(name);
                if (service === undefined) throw new Error(`no sign-in service is named "${name}"`);
                return service(request);
            },
        },
        environments: {
            kindOf: (name: string) =>
                name === "local" || name === "external"
                    ? name
                    : name === "production" || name === "prod"
                      ? "production"
                      : "test",
            list: () => [],
        },
        tunnels: {
            register: () => {},
            open: async () => {
                throw new Error("no tunnels in tests");
            },
        },
        transports: {
            register: () => {},
            request: async (name, request, signal) => {
                transportCalls.push({ name, request });
                const transport = transports.get(name);
                if (transport === undefined)
                    throw new Error(`no transport named "${name}" (none is registered); a company plugin registers it`);
                try {
                    return checked(await transport.request(request, signal));
                } catch (error) {
                    throw new Error(
                        `transport "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            },
        },
        // The real request logic over this fake's secrets, sign-in services, transports and network.
        http: { request: (request, signal) => http.request(request, signal) },

        mask: { text: (input) => input, value: (input) => input },
        watches: {
            registerKind: () => {},
            start: () => {
                throw new Error("no watches in tests");
            },
            list: () => [],
            stop: () => false,
        },
        config: {
            addEnvironments: () => {},
            addRules: () => {},
            addClassifyRules: () => {},
            addProtectedPaths: () => {},
            addSecretCommands: () => {},
            addMaskFields: () => {},
            addSectionDefaults: () => {},
            registerSection: (name, validate) => void sections.set(name, validate),
            section: (name) => {
                const value = values.get(name);
                const validate = sections.get(name);
                // As in jig-core: a section with errors is reported at start-up, and then reads as absent.
                return value !== undefined && (validate === undefined || validate(value).length === 0)
                    ? value
                    : undefined;
            },
        },
        protectedPaths: { list: () => [] },
        sandbox: {
            register: () => undefined,
            canRun: false,
            run: async () => {
                throw new Error("no sandbox in tests");
            },
        },
        gates: { register: () => undefined },
        approvals: { inTurn: (job) => job() },
        exec: {
            run: async () => {
                throw new Error("no programs in tests");
            },
            git: async () => {
                throw new Error("no programs in tests");
            },
        },
    };

    const http = createHttp({
        fetch: (input, init) => (fetchImpl ?? fetch)(input, init),
        secrets: { resolve: (reference, signal) => api.secrets.resolve(reference, signal) },
        signIn: { headers: (name, request, signal) => api.signIn.headers(name, request, signal) },
        transports: { request: (name, request, signal) => api.transports.request(name, request, signal) },
    });

    publishJig(api);
    return {
        api,
        declared,
        sections,
        approved,
        facts,
        secrets,
        secretCalls,
        signIn,
        signInCalls,
        transports,
        transportCalls,
        setFetch: (replacement) => {
            fetchImpl = replacement;
        },
        setSection: (name, value) => void values.set(name, value),
        publish: () => void publishJig(api),
        reset() {
            values.clear();
            approved.clear();
            facts.clear();
            secrets.clear();
            secretCalls.length = 0;
            signIn.clear();
            signInCalls.length = 0;
            transports.clear();
            transportCalls.length = 0;
            fetchImpl = undefined;
        },
        remove: () => withdrawJig(api),
    };
}
