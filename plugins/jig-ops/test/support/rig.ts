// A fake jig-core and a fake kubectl, wired together, for the tests that use the modules without the tool around them.
import { readK8s } from "../../src/runtime/kubernetes/config.ts";
import type { Target } from "../../src/runtime/kubernetes/config.ts";
import type { Kube } from "../../src/runtime/kubernetes/kubectl.ts";
import { installFakeKubectl } from "./fake-kubectl.ts";
import type { FakeKubectl } from "./fake-kubectl.ts";
import { installFakeJig } from "./fake-jig.ts";
import type { FakeJig } from "./fake-jig.ts";
import { section } from "./section.ts";

export interface Rig {
    jig: FakeJig;
    kubectl: FakeKubectl;
    /** A configured target. Default: orders-api in staging. */
    target(service?: string, environment?: string): Target;
    kube(target?: Target, signal?: AbortSignal): Kube;
    close(): void;
}

export function rig(): Rig {
    const jig = installFakeJig();
    const kubectl = installFakeKubectl();
    jig.useProgramsIn(kubectl.bin, kubectl.env);
    const settings = readK8s(section()).settings;
    if (settings === undefined) throw new Error("the default section is not valid");

    const target = (service = "orders-api", environment = "staging"): Target => {
        const found = settings.services.get(service)?.get(environment);
        if (found === undefined) throw new Error(`no target ${service}/${environment}`);
        return found;
    };
    return {
        jig,
        kubectl,
        target,
        kube: (chosen = target(), signal) => ({ target: chosen, signal }),
        close() {
            jig.remove();
            kubectl.remove();
        },
    };
}
