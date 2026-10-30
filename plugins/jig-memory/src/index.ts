// Pi entry point of jig-memory. The factory only registers: the `memory` section goes to jig-core, and the ticket
// memory is wired into the session. No file is touched until a session starts and a ticket becomes active.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withJig } from "../../jig-core/src/client.ts";
import { validateMemory } from "./config.ts";
import { registerTicketMemory } from "./session.ts";

export default function (pi: ExtensionAPI) {
    withJig((api) => api.config.registerSection("memory", validateMemory));
    registerTicketMemory(pi);
}
