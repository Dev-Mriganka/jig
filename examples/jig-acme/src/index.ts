// Pi entry point of jig-acme, the example company plugin. The factory only registers: no network, no processes, no timers and no file
// writes. It waits for jig-core (Pi may load this package first), then gives it everything Acme adds, one seam at a time:
//
//   environments     what the company calls its systems, and which are production           environments.ts
//   section defaults where Jira, the logs, the databases ... are, for each generic plugin  defaults/
//   secret commands  the tool that owns the login, by name                                  secrets.ts
//   sign-in service  the code that signs a request in                                       signin.ts
//   transport        the code that carries a request                                        transport.ts
//   tunnel           a local port that reaches a host behind a bastion                      tunnel.ts
//   masking          field names that hold personal data                                    masking.ts
//   protected paths  files the agent must not read                                          protection.ts
//   status           a line for /jig                                                        status.ts
//
// The skills (skills/acme-jira) are not registered here: the package manifest lists them and Pi loads them.
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { proxyOf, settingsOf, validateAcme, DEFAULT_GATEWAY_PROXY } from "./config.ts";
import { registerDefaults } from "./defaults/index.ts";
import { registerEnvironments } from "./environments.ts";
import { ACME_HOSTS } from "./hosts.ts";
import { withJig } from "./jig/client.ts";
import type { BastionDeps } from "./tunnel.ts";
import { registerTunnel } from "./tunnel.ts";
import { MASK_FIELDS } from "./masking.ts";
import { registerProtection } from "./protection.ts";
import { registerSecretCommands } from "./secrets.ts";
import { registerSignIn } from "./signin.ts";
import { registerStatus } from "./status.ts";
import { registerTransport } from "./transport.ts";

/** The parts of the machine this plugin reads, which a test replaces. */
export interface JigAcmeOptions {
    /** The hosts the sign-in service and the transport serve. Default: Acme's. */
    hosts?: readonly string[];
    /** Parts of the tunnel a test replaces: how long to wait, which environment ssh takes its agent from. */
    tunnel?: Partial<BastionDeps>;
}

/** The extension. Pi loads the default export below. */
export function jigAcme(options: JigAcmeOptions = {}): ExtensionFactory {
    return () => {
        withJig((api) => {
            const settings = () => settingsOf(api);
            const hosts = options.hosts ?? ACME_HOSTS;
            api.config.registerSection("acme", validateAcme);
            registerEnvironments(api);
            registerDefaults(api);
            registerSecretCommands(api);
            registerSignIn(api, settings, hosts);
            registerTransport(api, () => proxyOf(settings().gatewayProxy) ?? new URL(DEFAULT_GATEWAY_PROXY), hosts);
            registerTunnel(api, () => settings().bastion, options.tunnel);
            api.config.addMaskFields(MASK_FIELDS);
            registerProtection(api);
            registerStatus(api);
        });
    };
}

export default jigAcme();
