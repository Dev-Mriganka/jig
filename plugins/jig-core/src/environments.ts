// Environments: the names a call can act in, and the kind behind each name.
//
// `local`, `external` and `production` are built in. A company plugin adds its test environments (such as
// `staging`) and the names its tools use for production (such as `prod`). A name nobody defined counts as
// production, so a typo or a forgotten definition makes the rules stricter, never looser.
import type { Problem } from "./config.ts";
import type { EnvironmentConfig, EnvironmentKind, EnvironmentName } from "./contract.ts";

export const BUILT_IN_ENVIRONMENTS: Readonly<Record<string, EnvironmentKind>> = {
    local: "local",
    external: "external",
    production: "production",
};

export interface Environments {
    /** The kind of an environment. An unknown name is production. */
    kindOf(name: EnvironmentName): EnvironmentKind;
    isKnown(name: EnvironmentName): boolean;
    /** Whether results from this environment go through the mask backstop. Production always does, and so does
     *  an unknown name; a test environment only when configured with `mask: true`. */
    masks(name: EnvironmentName): boolean;
    /** Every defined name, the built-in ones first. */
    names(): string[];
}

/** Environments defined by one source, such as the personal file or a company plugin. */
export interface EnvironmentLayer {
    source: string;
    environments: Readonly<Record<string, EnvironmentConfig>>;
}

interface Defined {
    kind: "test" | "production";
    mask: boolean;
    source: string;
}

/**
 * Merges the layers in order, so give the weaker one first (the company's, then the personal file). A later
 * layer can make an environment stricter, but never looser: production stays production, and a mask stays on.
 * What a layer is not allowed to do comes back as problems, and the earlier definition stays.
 */
export function buildEnvironments(layers: readonly EnvironmentLayer[]): { environments: Environments; problems: Problem[] } {
    const defined = new Map<string, Defined>();
    const problems: Problem[] = [];

    for (const layer of layers) {
        for (const [name, config] of Object.entries(layer.environments)) {
            const key = `environments.${name}`;
            if (Object.hasOwn(BUILT_IN_ENVIRONMENTS, name)) {
                problems.push({ source: layer.source, key, message: `"${name}" is built in and cannot be redefined` });
                continue;
            }
            const before = defined.get(name);
            if (before === undefined) {
                const mask = config.kind === "production" || config.mask === true;
                defined.set(name, { kind: config.kind, mask, source: layer.source });
            } else if (before.kind === "production" && config.kind === "test") {
                problems.push({
                    source: layer.source,
                    key: `${key}.kind`,
                    message: `"${name}" is production (set by ${before.source}); configuration cannot lower it to a test environment`,
                });
            } else if (before.kind === "test" && config.kind === "production") {
                defined.set(name, { kind: "production", mask: true, source: layer.source });
            } else {
                before.mask = before.mask || config.mask === true;
            }
        }
    }

    const environments: Environments = {
        kindOf(name) {
            if (Object.hasOwn(BUILT_IN_ENVIRONMENTS, name)) return BUILT_IN_ENVIRONMENTS[name] as EnvironmentKind;
            return defined.get(name)?.kind ?? "production";
        },
        isKnown: (name) => Object.hasOwn(BUILT_IN_ENVIRONMENTS, name) || defined.has(name),
        masks(name) {
            const kind = environments.kindOf(name);
            if (kind === "production") return true;
            return kind === "test" && defined.get(name)?.mask === true;
        },
        names: () => [...Object.keys(BUILT_IN_ENVIRONMENTS), ...defined.keys()],
    };
    return { environments, problems };
}
