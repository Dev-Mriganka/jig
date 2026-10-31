// What `/jig` says about this company plugin. A plugin may give `/jig` lines about its own state, asked each time the command
// runs; a real company shows what a user needs to see at a glance: what is set up, and what is still missing for them.
//
// `status` is optional in the contract (a stand-in for jig-core in a test may not have it), hence the `?.`.
import { ENVIRONMENTS } from "./environments.ts";
import type { JigApi } from "./jig/types.ts";
import { settingsOf } from "./config.ts";
import { SSO_SERVICE } from "./signin.ts";
import { GATEWAY_TRANSPORT } from "./transport.ts";
import { BASTION_TUNNEL } from "./tunnel.ts";

export function registerStatus(api: JigApi): void {
    api.status?.register("jig-acme", () => {
        // `kindOf` is how a plugin asks what an environment is; there is no call that lists them, so the plugin keeps its own list.
        const environments = Object.keys(ENVIRONMENTS).map((name) => `${name} (${api.environments.kindOf(name)})`);
        const lines = [
            `jig-acme: environments ${environments.join(", ")}; sign-in ${SSO_SERVICE}; transport ${GATEWAY_TRANSPORT}; tunnel ${BASTION_TUNNEL}`,
        ];
        if (settingsOf(api).bastion.user === undefined) {
            lines.push(
                "jig-acme: acme.bastion.user is not set in jig.json, so the staging and prod databases cannot be reached",
            );
        }
        return lines;
    });
}
