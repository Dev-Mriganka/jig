// The environments a company works in. A real company lists the names its tools and its logs use, and says which are test
// systems and which hold live customer data.
//
// `dev` and `staging` are test environments: a write to them asks first, as Jig's rules table says. `prod` is production, so
// Jig's floor makes it read-only and masks every result; nothing in this file can change that. `staging` also sets `mask`,
// because Acme loads copies of customer data into it: its results are masked like production's.
//
// These are the names the generic plugins are configured with (the keys of `logs.environments`, `mongo.connections`,
// `ops.services.*.environments`): a name nobody defined counts as production.
import type { EnvironmentConfig, JigApi } from "./jig/types.ts";

export const ENVIRONMENTS: Readonly<Record<string, EnvironmentConfig>> = {
    dev: { kind: "test" },
    staging: { kind: "test", mask: true },
    prod: { kind: "production" },
};

export function registerEnvironments(api: JigApi): void {
    api.config.addEnvironments(ENVIRONMENTS);
}
