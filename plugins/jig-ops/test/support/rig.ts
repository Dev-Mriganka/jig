// A fake jig-core and the fake programs, wired together, for the tests that use the modules without the tools around them.
import { readOps } from "../../src/catalog.ts";
import type { Catalog, Environment } from "../../src/catalog.ts";
import type { Target } from "../../src/runtime/kubernetes/config.ts";
import type { Kube } from "../../src/runtime/kubernetes/kubectl.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";
import { installFakePrograms } from "./fake-programs.ts";
import type { FakePrograms } from "./fake-programs.ts";
import { section } from "./section.ts";

export interface Rig {
    jig: FakeJig;
    cluster: FakePrograms;
    catalog: Catalog;
    /** A configured environment. Default: orders-api in staging. */
    environment(service?: string, environment?: string): Environment;
    /** The Kubernetes target of a configured environment. Default: orders-api in staging. */
    target(service?: string, environment?: string): Target;
    kube(target?: Target, signal?: AbortSignal): Kube;
    close(): void;
}

export function rig(): Rig {
    const jig = installFakeJig();
    const cluster = installFakePrograms();
    jig.useProgramsIn(cluster.bin, cluster.env);
    const { catalog } = readOps(section());
    if (catalog === undefined) throw new Error("the default section is not valid");

    const environment = (service = "orders-api", name = "staging"): Environment => {
        const found = catalog.services.get(service)?.environments.get(name);
        if (found === undefined) throw new Error(`no environment ${service}/${name}`);
        return found;
    };
    const target = (service?: string, name?: string): Target => {
        const found = environment(service, name).kubernetes;
        if (found === undefined) throw new Error(`no Kubernetes runtime for ${service ?? "orders-api"}/${name ?? "staging"}`);
        return found;
    };
    return {
        jig,
        cluster,
        catalog,
        environment,
        target,
        kube: (chosen = target(), signal) => ({ target: chosen, signal }),
        close() {
            jig.remove();
            cluster.remove();
        },
    };
}
