// The fake Pi that tests of every plugin load into: it has the calls the Jig plugins make besides jig-core's own, and keeps what
// they were given, so a test of "every plugin" needs no stand-ins.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeContext, fakePi } from "./support/fake-pi.ts";

describe("the fake Pi", () => {
    test("keeps the entries a plugin appended, in order, and the renderers it registered", () => {
        const host = fakePi();
        const { pi } = host;
        const draw = () => undefined;
        pi.registerEntryRenderer("lens", draw as never);
        pi.registerMessageRenderer("note", draw as never);
        pi.appendEntry("lens", { blocks: [1] });
        pi.appendEntry("ticket", { key: "PROJ-1" });
        assert.deepEqual(host.entries, [
            { customType: "lens", data: { blocks: [1] } },
            { customType: "ticket", data: { key: "PROJ-1" } },
        ]);
        assert.equal(host.entryRenderers.get("lens"), draw);
        assert.equal(host.messageRenderers.get("note"), draw);
    });

    test("keeps the messages a plugin sent as the user, with their options", () => {
        const host = fakePi();
        host.pi.sendUserMessage("approved", { deliverAs: "followUp" });
        assert.deepEqual(host.userMessages, [{ content: "approved", options: { deliverAs: "followUp" } }]);
    });

    test("answers the thinking level it is told, off to begin with", () => {
        const host = fakePi();
        assert.equal(host.pi.getThinkingLevel(), "off");
        host.thinkingLevel = "high";
        assert.equal(host.pi.getThinkingLevel(), "high");
    });

    test("a context has a session whose branch is empty unless the test gives one", () => {
        assert.deepEqual(fakeContext().ctx.sessionManager.getBranch(), []);
        const entry = { type: "custom", customType: "ticket", data: { key: "PROJ-1" } };
        const { ctx } = fakeContext({ branch: [entry] });
        assert.deepEqual(ctx.sessionManager.getBranch(), [entry]);
        assert.equal(ctx.sessionManager.getSessionId(), "session-test");
    });
});
