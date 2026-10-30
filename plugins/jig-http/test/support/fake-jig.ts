// A stand-in for jig-core's run-time API, published on the same process-wide slot, so the plugin runs as it would under
// jig-core. Only what jig-http uses is real: the section of jig.json, secrets, sign-in services, transports, the approved
// preview and the facts. Everything the plugin tells jig-core or asks of it is recorded for the tests.
import { publishJig, withdrawJig } from "../../../jig-core/src/client.ts";
import type {
    Facts, JigApi, Preview, SignInRequest, ToolDeclaration, Transport, TransportRequest, TransportResponse,
} from "../../../jig-core/src/contract.ts";

type Headers = Record<string, string>;

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
    signIn: Map<string, (request: SignInRequest) => Headers | Promise<Headers>>;
    signInCalls: Array<{ name: string; request: SignInRequest }>;
    /** Transports by name. Every request sent through one is recorded, as the transport received it. */
    transports: Map<string, Transport>;
    transportCalls: Array<{ name: string; request: TransportRequest }>;
    /** What `config.section(name)` returns once the section passes its check, as at jig-core's session start. */
    setSection(name: string, value: unknown): void;
    /** Makes this the jig-core that plugins reach. Only one can be: a test with two fakes calls this before it uses either. */
    publish(): void;
    reset(): void;
    remove(): void;
}

/** What jig-core does with a transport's answer: it names the header fields in lower case. */
function checked(value: TransportResponse): TransportResponse {
    const headers = Object.fromEntries(Object.entries(value.headers).map(([name, text]) => [name.toLowerCase(), text]));
    return { status: value.status, headers, body: value.body };
}

export function installFakeJig(): FakeJig {
    const declared = new Map<string, ToolDeclaration>();
    const sections = new Map<string, (raw: unknown) => readonly string[]>();
    const values = new Map<string, unknown>();
    const approved = new Map<string, Preview>();
    const facts = new Map<string, Facts[]>();
    const secrets = new Map<string, string>();
    const secretCalls: string[] = [];
    const signIn: FakeJig["signIn"] = new Map();
    const signInCalls: FakeJig["signInCalls"] = [];
    const transports = new Map<string, Transport>();
    const transportCalls: FakeJig["transportCalls"] = [];

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
                try {
                    return await service(request);
                } catch (error) {
                    throw new Error(`sign-in service "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            },
        },
        environments: {
            kindOf: (name: string) => (name === "local" || name === "external" ? name : name === "production" || name === "prod" ? "production" : "test"),
        },
        transports: {
            register: () => {},
            request: async (name, request, signal) => {
                transportCalls.push({ name, request });
                const transport = transports.get(name);
                if (transport === undefined) throw new Error(`no transport named "${name}" (none is registered); a company plugin registers it`);
                try {
                    return checked(await transport.request(request, signal));
                } catch (error) {
                    throw new Error(`transport "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            },
        },
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
            addMaskFields: () => {},
            registerSection: (name, validate) => void sections.set(name, validate),
            section: (name) => {
                const value = values.get(name);
                const validate = sections.get(name);
                // As in jig-core: a section with errors is reported at start-up, and then reads as absent.
                return value !== undefined && (validate === undefined || validate(value).length === 0) ? value : undefined;
            },
        },
        exec: {
            run: async () => {
                throw new Error("no programs in tests");
            },
            git: async () => {
                throw new Error("no programs in tests");
            },
        },
    };

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
        },
        remove: () => withdrawJig(api),
    };
}
