// The `ops` section of jig.json: the service catalog. Each service is described once, with the environments it runs in,
// how to deploy there, where it runs and its health address. jig-core checks the section with validateOps when a
// session starts, so the rest of the plugin reads a catalog that is valid.
//
// A call never names a context, a namespace, a release or an address. It names a service and an environment, and this
// catalog says where that is, so nothing outside the catalog can be reached through the tools.
import { checkDeploy } from "./deploy/methods.ts";
import type { DeployConfig } from "./deploy/methods.ts";
import { checkKubernetes } from "./runtime/kubernetes/config.ts";
import type { Target } from "./runtime/kubernetes/config.ts";
import { InputError, isObject, shortList, shown } from "./values.ts";

/** One service in one environment: the part of the catalog a call acts on. */
export interface Environment {
    service: string;
    /**
     * The name in the catalog and in a call. It is also the name that jig-core knows the environment by, so its rules,
     * its masking and the kind (test or production) of the environment come from that name.
     */
    name: string;
    deploy?: DeployConfig;
    /** The Kubernetes runtime: where the pods are. */
    kubernetes?: Target;
    /** An https address that answers when the service is healthy. */
    health?: string;
}

export interface Service {
    name: string;
    /** Where the code lives, for finding the CI run of a commit. */
    repo?: string;
    /** The CI system and what to look at in it. Accepted and kept; nothing reads it until the `ci` tool exists. */
    ci?: Readonly<Record<string, string>>;
    environments: ReadonlyMap<string, Environment>;
}

export interface Catalog {
    /** By service name. A Map, so that a name such as `constructor` is only ever a name. */
    services: ReadonlyMap<string, Service>;
}

const SECTION_FIELDS: ReadonlySet<string> = new Set(["services"]);
const SERVICE_FIELDS: ReadonlySet<string> = new Set(["repo", "ci", "environments"]);
const ENVIRONMENT_FIELDS: ReadonlySet<string> = new Set(["deploy", "runtime", "health"]);
/**
 * The runtimes an environment can have. A new one (Docker Compose, ECS) is a folder beside kubernetes/ and a name here.
 */
const RUNTIMES = ["kubernetes"] as const;

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const REPO = /^[^\s\u0000-\u001f\u007f]{1,200}$/;
const CI_SYSTEM = /^[a-z][a-z0-9-]{0,39}$/;
const CI_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_SERVICES = 100;
const MAX_ENVIRONMENTS = 20;
const MAX_HEALTH_CHARS = 500;

const NOT_SET_UP =
    'ops is not set up: add an "ops" section with "services" to jig.json (/jig lists configuration problems)';

export function notSetUp(): InputError {
    return new InputError(NOT_SET_UP);
}

/**
 * Why an address cannot be a health address, or undefined when it can. It must be an https address, with no user name
 * or password and no fragment. The health check asks this again for every request, whatever the catalog says.
 */
export function healthProblem(address: unknown): string | undefined {
    const notHttps = "must be an https address, such as https://api.staging.example.com/orders/health";
    if (typeof address !== "string" || address.length > MAX_HEALTH_CHARS || CONTROL.test(address)) return notHttps;
    // The URL parser also reads `https:/host` and `https:///host` as a host. An address is written out in full.
    if (!/^https:\/\/[^\s/\\?#]/i.test(address)) return notHttps;
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return notHttps;
    }
    if (url.protocol !== "https:" || url.hostname === "") return notHttps;
    if (url.username !== "" || url.password !== "") return "must not contain a user name or password";
    if (url.hash !== "") return "must not contain a fragment";
    return undefined;
}

function checkCi(raw: unknown, at: string, errors: string[]): Record<string, string> | undefined {
    if (!isObject(raw)) {
        errors.push(
            `${at}: must be an object with a system, such as { "system": "github-actions", "workflow": "build.yml" }`,
        );
        return undefined;
    }
    const before = errors.length;
    const found: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!CI_FIELD.test(key)) {
            errors.push(`${at}: ${shown(key, 30)} is not a usable field name`);
        } else if (typeof value !== "string" || value === "" || value.length > 200 || CONTROL.test(value)) {
            errors.push(`${at}.${key}: must be text of 1 to 200 characters`);
        } else if (key === "system" && !CI_SYSTEM.test(value)) {
            errors.push(`${at}.system: must be the name of a CI system, such as github-actions`);
        } else {
            found[key] = value;
        }
    }
    if (raw.system === undefined) errors.push(`${at}.system: required, the CI system, such as github-actions`);
    return errors.length > before ? undefined : found;
}

function checkRuntime(raw: unknown, at: string, errors: string[]): Omit<Target, "service" | "environment"> | undefined {
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object that names a runtime: ${RUNTIMES.join(" or ")}`);
        return undefined;
    }
    const names = Object.keys(raw);
    const before = errors.length;
    for (const name of names) {
        if (!(RUNTIMES as readonly string[]).includes(name)) {
            errors.push(`${at}.${name}: unknown runtime; the runtimes there are: ${RUNTIMES.join(", ")}`);
        }
    }
    if (names.length === 0) errors.push(`${at}: must name a runtime: ${RUNTIMES.join(" or ")}`);
    if (errors.length > before) return undefined;
    return checkKubernetes(raw.kubernetes, `${at}.kubernetes`, errors);
}

function checkEnvironment(
    service: string,
    name: string,
    raw: unknown,
    at: string,
    errors: string[],
): Environment | undefined {
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object with deploy, runtime or health`);
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!ENVIRONMENT_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);
    if (raw.deploy === undefined && raw.runtime === undefined && raw.health === undefined) {
        errors.push(`${at}: must have at least one of deploy, runtime and health`);
    }

    const deploy = raw.deploy === undefined ? undefined : checkDeploy(raw.deploy, `${at}.deploy`, errors);
    const runtime = raw.runtime === undefined ? undefined : checkRuntime(raw.runtime, `${at}.runtime`, errors);
    let health: string | undefined;
    if (raw.health !== undefined) {
        const problem = healthProblem(raw.health);
        if (problem === undefined) health = raw.health as string;
        else errors.push(`${at}.health: ${problem}`);
    }
    // Both deploy methods change a cluster, and take the context and the namespace from its runtime.
    if (raw.deploy !== undefined && raw.runtime === undefined) {
        errors.push(
            `${at}.deploy: deploys to a Kubernetes cluster, ` +
                "so the environment needs runtime.kubernetes (the context and the namespace)",
        );
    }

    if (errors.length > before) return undefined;
    return {
        service,
        name,
        ...(deploy === undefined ? {} : { deploy }),
        ...(runtime === undefined ? {} : { kubernetes: { service, environment: name, ...runtime } }),
        ...(health === undefined ? {} : { health }),
    };
}

function checkService(name: string, raw: unknown, at: string, errors: string[]): Service | undefined {
    if (!isObject(raw)) {
        errors.push(`${at}: must be an object with environments`);
        return undefined;
    }
    const before = errors.length;
    for (const key of Object.keys(raw)) if (!SERVICE_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field`);

    let repo: string | undefined;
    if (raw.repo !== undefined) {
        if (typeof raw.repo === "string" && REPO.test(raw.repo)) repo = raw.repo;
        else errors.push(`${at}.repo: must be text of 1 to 200 characters, no white space, such as acme/orders-api`);
    }
    const ci = raw.ci === undefined ? undefined : checkCi(raw.ci, `${at}.ci`, errors);

    const environments = new Map<string, Environment>();
    if (!isObject(raw.environments) || Object.keys(raw.environments).length === 0) {
        const need = raw.environments === undefined ? "required, " : "must be ";
        errors.push(
            `${at}.environments: ${need}an object that maps an environment name to its deploy, runtime and health`,
        );
    } else if (Object.keys(raw.environments).length > MAX_ENVIRONMENTS) {
        errors.push(`${at}.environments: at most ${MAX_ENVIRONMENTS} environments`);
    } else {
        for (const [environment, entry] of Object.entries(raw.environments)) {
            if (!ENVIRONMENT_NAME.test(environment)) {
                errors.push(
                    `${at}.environments: ${shown(environment, 30)} is not a usable environment name ` +
                        "(letters, digits, _ and -)",
                );
                continue;
            }
            const read = checkEnvironment(name, environment, entry, `${at}.environments.${environment}`, errors);
            if (read !== undefined) environments.set(environment, read);
        }
    }

    if (errors.length > before) return undefined;
    return { name, ...(repo === undefined ? {} : { repo }), ...(ci === undefined ? {} : { ci }), environments };
}

/**
 * Checks a raw `ops` section and reads it. `errors` name their key; with any error there is no catalog. A misspelt
 * field is an error and not a silent default: `namespce` would otherwise leave a service without its namespace.
 */
export function readOps(raw: unknown): { catalog?: Catalog; errors: string[] } {
    if (!isObject(raw)) return { errors: ["ops: must be an object"] };
    const errors: string[] = [];
    for (const key of Object.keys(raw)) if (!SECTION_FIELDS.has(key)) errors.push(`ops.${key}: unknown field`);

    if (!isObject(raw.services)) {
        const need = raw.services === undefined ? "required, " : "must be ";
        errors.push(`ops.services: ${need}an object that maps a service name to its entry`);
        return { errors };
    }
    const entries = Object.entries(raw.services);
    if (entries.length === 0 || entries.length > MAX_SERVICES) {
        errors.push(`ops.services: must name 1 to ${MAX_SERVICES} services`);
        return { errors };
    }
    const services = new Map<string, Service>();
    for (const [name, entry] of entries) {
        if (!SERVICE_NAME.test(name)) {
            errors.push(
                `ops.services: ${shown(name, 30)} is not a usable service name ` +
                    "(1 to 40 letters, digits, . _ -, starting with a letter or digit)",
            );
            continue;
        }
        const service = checkService(name, entry, `ops.services.${name}`, errors);
        if (service !== undefined) services.set(name, service);
    }
    return errors.length > 0 ? { errors } : { errors, catalog: { services } };
}

/** The error messages for a raw section, for `registerSection`. An empty list means the section is valid. */
export function validateOps(raw: unknown): string[] {
    return readOps(raw).errors;
}

const parsed = new WeakMap<object, Catalog | undefined>();

/** The catalog in a raw section, or undefined when it is absent or invalid. Read again only when the object changes. */
export function catalogOf(raw: unknown): Catalog | undefined {
    if (!isObject(raw)) return undefined;
    if (!parsed.has(raw)) parsed.set(raw, readOps(raw).catalog);
    return parsed.get(raw);
}

/** `orders-api (staging, production), billing (staging)`: what a message offers when a service name is wrong. */
export function describeServices(catalog: Catalog): string {
    return shortList(
        [...catalog.services.values()].map(
            (service) => `${service.name} (${shortList([...service.environments.keys()], 60)})`,
        ),
    );
}

/**
 * The service and environment a call names. A name nobody configured is invalid input, and the message lists the ones
 * there are, because the model has no other way to learn them. `who` is the tool, so a message starts with its name.
 */
export function findEnvironment(catalog: Catalog, who: string, service: unknown, environment: unknown): Environment {
    const found = typeof service === "string" ? catalog.services.get(service) : undefined;
    if (found === undefined) {
        throw new InputError(
            `${who}: no service named ${shown(service, 30)}. Known services: ${describeServices(catalog)}`,
        );
    }
    const target = typeof environment === "string" ? found.environments.get(environment) : undefined;
    if (target === undefined) {
        throw new InputError(
            `${who}: ${found.name} has no environment ${shown(environment, 30)}. ` +
                `Known environments: ${shortList([...found.environments.keys()])}`,
        );
    }
    return target;
}
