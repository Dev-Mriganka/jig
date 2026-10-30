// The environment a sandboxed command starts with: credentials out, the rest as Pi has it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { looksLikeCredential, scrubEnvironment } from "../src/env.ts";

describe("which names are removed", () => {
    test("names that look like credentials, whatever their case", () => {
        for (const name of [
            "GITHUB_TOKEN",
            "github_token",
            "NPM_TOKEN",
            "MY_SECRET",
            "DB_PASSWORD",
            "DB_PASSWD",
            "STRIPE_API_KEY",
            "SERVICE_KEY",
            "APIKEY",
            "SOME_APIKEY_VALUE",
            "REGISTRY_CREDENTIALS",
            "AWS_PROFILE",
            "AWS_ACCESS_KEY_ID",
            "AZURE_CLIENT_ID",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GH_HOST",
            "GITHUB_ACTIONS",
            "VAULT_ADDR",
            "KUBECONFIG",
            "SSH_AUTH_SOCK",
            "GPG_AGENT_INFO",
            "DBUS_SESSION_BUS_ADDRESS",
            "WSL_INTEROP",
        ]) {
            assert.equal(looksLikeCredential(name), true, name);
        }
    });

    test("ordinary names are kept", () => {
        for (const name of [
            "PATH",
            "HOME",
            "LANG",
            "TERM",
            "JAVA_HOME",
            "KEYBOARD_LAYOUT",
            "MONKEY",
            "PI_SESSION_ID",
            "TMPDIR",
            "NODE_ENV",
            "CI",
        ]) {
            assert.equal(looksLikeCredential(name), false, name);
        }
    });
});

describe("scrubEnvironment", () => {
    const source = {
        PATH: "/usr/bin:/mnt/c/Windows:/mnt/c/Program Files/Git/cmd:/home/me/bin",
        HOME: "/home/me",
        GITHUB_TOKEN: "ghs_0123456789abcdef",
        SHORT_SECRET: "abc",
        MY_API_KEY: "key-value-long-enough",
        LANG: "C.UTF-8",
    };

    test("removes credentials and says which, in order, with the values worth scrubbing from output", () => {
        const result = scrubEnvironment(source, { keep: [] });
        assert.deepEqual(result.env, { PATH: source.PATH, HOME: "/home/me", LANG: "C.UTF-8" });
        assert.deepEqual(result.removed, ["GITHUB_TOKEN", "MY_API_KEY", "SHORT_SECRET"]);
        assert.deepEqual(
            result.values,
            ["key-value-long-enough", "ghs_0123456789abcdef"],
            "longest first, and a value of three letters is not scrubbed from output",
        );
    });

    test("`env.keep` passes a named variable through, without regard to case", () => {
        const result = scrubEnvironment(source, { keep: ["my_api_key"] });
        assert.equal(result.env.MY_API_KEY, "key-value-long-enough");
        assert.ok(!result.removed.includes("MY_API_KEY"));
        assert.equal(result.env.GITHUB_TOKEN, undefined);
    });

    test("PATH entries inside hidden folders are dropped, and variables are added", () => {
        const result = scrubEnvironment(source, { keep: [], hiddenFolders: ["/mnt"], set: { TMPDIR: "/tmp/session" } });
        assert.equal(result.env.PATH, "/usr/bin:/home/me/bin");
        assert.equal(result.env.TMPDIR, "/tmp/session");
    });

    test("the source is not changed", () => {
        const copy = { ...source };
        scrubEnvironment(source, { keep: [] });
        assert.deepEqual(source, copy);
    });

    test("an undefined value is not passed on", () => {
        assert.deepEqual(scrubEnvironment({ A: undefined, B: "1" }, { keep: [] }).env, { B: "1" });
    });
});
