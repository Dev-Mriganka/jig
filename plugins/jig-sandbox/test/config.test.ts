// The `sandbox` section of jig.json: what is accepted, and what each mistake says.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ROLE_POLICY_VARIABLE, writeRolePolicy } from "../../jig-core/src/kit/role-policy.ts";
import { DEFAULT_SETTINGS, denyNotApplied, readOnlyRole, settingsFrom, validateSandbox } from "../src/config.ts";

describe("validateSandbox", () => {
    test("an empty section and a full one are valid", () => {
        assert.deepEqual(validateSandbox({}), []);
        assert.deepEqual(
            validateSandbox({
                share: ["/mnt/c/Users/me/work"],
                hide: ["~/private-notes"],
                lock: ["~/bin/deploy.sh"],
                network: {
                    mode: "open",
                    allow: ["api.example.com", "*.example.com:443"],
                    deny: ["db.example.com"],
                    localhost: [5432],
                },
                env: { keep: ["MY_API_KEY"] },
                docker: false,
                background: { maxTasks: 4, maxRuntimeMinutes: 240, keepFinished: 12, wake: "on" },
                programs: { bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat", ripgrep: "/usr/bin/rg" },
            }),
            [],
        );
    });

    test("a misspelt field is an error that names it", () => {
        assert.deepEqual(validateSandbox({ shar: [] }), ["sandbox.shar: unknown field"]);
        assert.deepEqual(validateSandbox({ network: { mod: "off" } }), ["sandbox.network.mod: unknown field"]);
        assert.deepEqual(validateSandbox({ env: { kep: [] } }), ["sandbox.env.kep: unknown field"]);
        assert.deepEqual(validateSandbox({ programs: { rg: "/usr/bin/rg" } }), [
            "sandbox.programs.rg: unknown field (bwrap, socat or ripgrep)",
        ]);
    });

    test("paths must be absolute or start with ~/", () => {
        const errors = validateSandbox({ share: ["work"], hide: ["~notes", "/ok"], lock: [""] });
        assert.equal(errors.length, 3);
        assert.match(errors[0] ?? "", /sandbox\.share: "work" must be absolute or start with ~\//);
        assert.match(errors[2] ?? "", /sandbox\.lock: must be a list of paths/);
    });

    test("the network mode is one of the four", () => {
        assert.deepEqual(validateSandbox({ network: { mode: "wide-open" } }), [
            "sandbox.network.mode: must be one of open, filtered, ask, off",
        ]);
        for (const mode of ["open", "filtered", "ask", "off"])
            assert.deepEqual(validateSandbox({ network: { mode } }), []);
    });

    test("hosts and ports are checked", () => {
        assert.equal(validateSandbox({ network: { allow: ["not a host"] } }).length, 1);
        assert.equal(validateSandbox({ network: { deny: ["a.example.com:99999x"] } }).length, 1);
        assert.deepEqual(validateSandbox({ network: { localhost: [0] } }), [
            "sandbox.network.localhost: must be a list of ports from 1 to 65535",
        ]);
        assert.deepEqual(validateSandbox({ network: { localhost: "5432" } }), [
            "sandbox.network.localhost: must be a list of ports from 1 to 65535",
        ]);
    });

    test("types are checked", () => {
        assert.deepEqual(validateSandbox("x"), ["sandbox: must be an object"]);
        assert.deepEqual(validateSandbox({ docker: "yes" }), ["sandbox.docker: must be true or false"]);
        assert.deepEqual(validateSandbox({ env: { keep: ["not a name"] } }), [
            "sandbox.env.keep: must be a list of variable names",
        ]);
        assert.deepEqual(validateSandbox({ background: { maxTasks: 0 } }), [
            "sandbox.background.maxTasks: must be a whole number of at least 1",
        ]);
        assert.deepEqual(validateSandbox({ background: { keepFinished: 0, wake: "sometimes" } }), [
            "sandbox.background.keepFinished: must be a whole number of at least 1",
            "sandbox.background.wake: must be on or off",
        ]);
        assert.deepEqual(validateSandbox({ background: { wake: "off", keepFinished: 3 } }), []);
        assert.deepEqual(validateSandbox({ background: { speed: 1 } }), ["sandbox.background.speed: unknown field"]);
        assert.deepEqual(validateSandbox({ programs: { bwrap: "bwrap" } }), [
            "sandbox.programs.bwrap: must be an absolute path",
        ]);
    });
});

describe("settingsFrom", () => {
    test("nothing gives the defaults, which keep the network open", () => {
        assert.deepEqual(settingsFrom(undefined), DEFAULT_SETTINGS);
        assert.equal(settingsFrom({}).network.mode, "open");
        assert.equal(settingsFrom({}).docker, false);
    });

    test("a field is taken as written, and a wrong one is the default", () => {
        const settings = settingsFrom({
            share: ["/srv/work", 4],
            network: { mode: "off", localhost: [5432, "x", 0] },
            env: { keep: ["MY_API_KEY"] },
            programs: { socat: "/opt/socat", ripgrep: "rg" },
            background: { maxTasks: 2, wake: "off" },
        });
        assert.deepEqual(settings.share, []);
        assert.equal(settings.network.mode, "off");
        assert.deepEqual(settings.network.localhost, [5432]);
        assert.deepEqual(settings.env.keep, ["MY_API_KEY"]);
        assert.deepEqual(settings.programs, { socat: "/opt/socat" });
        assert.deepEqual(settings.background, { maxTasks: 2, maxRuntimeMinutes: 240, keepFinished: 12, wake: "off" });
    });
});

describe("readOnlyRole", () => {
    const policy = (writes: boolean): string => writeRolePolicy({ role: "scout", writes, actions: {}, ask: {} });

    test("is true for a child whose role may not write, false for one that may, and false when there is no policy", () => {
        assert.equal(readOnlyRole({ [ROLE_POLICY_VARIABLE]: policy(false) }), true);
        assert.equal(readOnlyRole({ [ROLE_POLICY_VARIABLE]: policy(true) }), false);
        assert.equal(readOnlyRole({}), false);
    });

    test("is true when the policy is there and cannot be read: the sandbox locks more when it is not sure", () => {
        for (const text of ["", "{not json", "[]", '{"v":9}']) {
            assert.equal(readOnlyRole({ [ROLE_POLICY_VARIABLE]: text }), true, text);
        }
    });

    test("is never set by the section of jig.json: the field is not one the section accepts or reads", () => {
        assert.deepEqual(validateSandbox({ readOnly: true }), ["sandbox.readOnly: unknown field"]);
        assert.equal(settingsFrom({ readOnly: true }).readOnly, false);
    });
});

describe("denyNotApplied", () => {
    const network = (mode: "open" | "filtered" | "ask" | "off", deny: string[]) => ({
        network: { ...DEFAULT_SETTINGS.network, mode, deny },
    });

    test("warns when hosts are denied in the open mode, naming them", () => {
        const warning = denyNotApplied(network("open", ["a.example.com", "*.b.example.com:443"]));
        assert.match(
            warning ?? "",
            /^sandbox\.network\.deny \(a\.example\.com, \*\.b\.example\.com:443\) does nothing in the open network mode/,
        );
        assert.match(warning ?? "", /apply in filtered and ask only, so these hosts are NOT refused/);
        assert.match(warning ?? "", /Set sandbox\.network\.mode to filtered or ask/);
    });

    test("shortens a long list", () => {
        const hosts = Array.from({ length: 8 }, (_, i) => `h${i}.example.com`);
        assert.match(
            denyNotApplied(network("open", hosts)) ?? "",
            /\(h0\.example\.com, .*h4\.example\.com and 3 more\)/,
        );
    });

    test("says nothing when the list is empty, or the mode is one that applies it (or has no network at all)", () => {
        assert.equal(denyNotApplied(network("open", [])), undefined);
        for (const mode of ["filtered", "ask", "off"] as const)
            assert.equal(denyNotApplied(network(mode, ["a.example.com"])), undefined, mode);
    });
});
