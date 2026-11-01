// The isolated environment every test starts in (test/support/hermetic.mjs): a result must not depend on the machine's home folder,
// git configuration, credentials or Pi agent folder. The first tests look at this very process, which that file already set up; the
// others start a process of their own with a dirty environment and look at what the file made of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

const HOST = path.resolve(import.meta.dirname, "../../../test/support/host.mjs");

/** The environment a process has after host.mjs ran, started from exactly `dirty` plus a PATH. */
function inside(dirty: Record<string, string>): Record<string, string | undefined> {
    const output = execFileSync(process.execPath, ["--import", HOST, "-p", "JSON.stringify(process.env)"], {
        env: { PATH: process.env.PATH ?? "", HOME: "/home/someone", ...dirty },
        encoding: "utf8",
    });
    return JSON.parse(output) as Record<string, string | undefined>;
}

describe("this process", () => {
    test("has a temporary, empty home and agent folder, and no state yet", () => {
        const home = process.env.HOME ?? "";
        const root = path.dirname(home);
        assert.ok(root.startsWith(path.join(tmpdir(), "jig-test-")), `${home} is not under a jig-test folder`);
        assert.deepEqual(readdirSync(home), []);
        assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, "agent"));
        assert.deepEqual(readdirSync(process.env.PI_CODING_AGENT_DIR ?? ""), []);
        assert.equal(process.env.JIG_STATE_DIR, path.join(root, "state"));
        assert.deepEqual(readdirSync(process.env.PASSWORD_STORE_DIR ?? ""), []);
    });

    test("gives git a test identity and no other configuration, not even the machine's", () => {
        const folder = path.dirname(process.env.HOME ?? "");
        const listed = execFileSync("git", ["config", "--list", "--show-origin"], { cwd: folder, encoding: "utf8" });
        const origins = new Set(
            listed
                .split("\n")
                .filter(Boolean)
                .map((line) => line.split("\t")[0]),
        );
        assert.deepEqual([...origins], [`file:${process.env.GIT_CONFIG_GLOBAL}`]);
        assert.match(listed, /user\.email=test@example\.com/);
    });

    test("tells Pi to stay offline", () => {
        assert.equal(process.env.PI_OFFLINE, "1");
        assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1");
        assert.equal(process.env.PI_TELEMETRY, "0");
    });
});

describe("a process started from a dirty environment", () => {
    test("loses cloud and forge credentials, agents, git's repository variables and the XDG folders", () => {
        const dirty = {
            AWS_PROFILE: "work",
            AWS_SECRET_ACCESS_KEY: "x",
            AZURE_CLIENT_ID: "x",
            GH_TOKEN: "x",
            GITHUB_TOKEN: "x",
            GITLAB_TOKEN: "x",
            NPM_TOKEN: "x",
            SSH_AUTH_SOCK: "/run/agent.sock",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
            KUBECONFIG: "/home/someone/.kube/config",
            ANTHROPIC_API_KEY: "x",
            GIT_DIR: "/somewhere/.git",
            GIT_INDEX_FILE: "/somewhere/.git/index",
            XDG_STATE_HOME: "/home/someone/state",
            XDG_CONFIG_HOME: "/home/someone/config",
        };
        const env = inside(dirty);
        for (const name of Object.keys(dirty)) assert.equal(env[name], undefined, `${name} is still set`);
    });

    test("has its home, git configuration, Pi agent folder, state and password store in one temporary folder", () => {
        const env = inside({ PI_CODING_AGENT_DIR: "/home/someone/.pi/agent", JIG_STATE_DIR: "/home/someone/state" });
        const root = path.dirname(env.HOME ?? "");
        assert.notEqual(env.HOME, "/home/someone");
        for (const name of [
            "GIT_CONFIG_GLOBAL",
            "PI_CODING_AGENT_DIR",
            "JIG_STATE_DIR",
            "PASSWORD_STORE_DIR",
            "GNUPGHOME",
        ]) {
            assert.equal(path.dirname(env[name] ?? ""), root, `${name} is ${env[name]}`);
        }
        assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
        assert.equal(env.PI_OFFLINE, "1");
    });

    test("gets a new folder each time, and the folder is gone when the process ends", () => {
        const first = inside({});
        const second = inside({});
        assert.notEqual(first.HOME, second.HOME);
        assert.equal(existsSync(first.HOME ?? ""), false);
    });

    test("keeps what an integration suite names: its services, its CA file, and the token only the GitHub suites use", () => {
        const services = inside({
            JIG_IT_LOKI_URL: "http://127.0.0.1:3100",
            JIG_IT_MONGO_PASSWORD: "throwaway",
            NODE_EXTRA_CA_CERTS: "/tmp/ca.crt",
            GH_TOKEN: "x",
        });
        assert.equal(services.JIG_IT_LOKI_URL, "http://127.0.0.1:3100");
        assert.equal(services.JIG_IT_MONGO_PASSWORD, "throwaway");
        assert.equal(services.NODE_EXTRA_CA_CERTS, "/tmp/ca.crt");
        assert.equal(services.GH_TOKEN, undefined, "without a GitHub suite the token goes");
        assert.equal(inside({ JIG_IT_GITHUB: "1", GH_TOKEN: "x" }).GH_TOKEN, "x");
        assert.equal(inside({ JIG_IT_GITHUB_REPOSITORY: "acme/app", GITHUB_TOKEN: "x" }).GITHUB_TOKEN, "x");
    });

    test("keeps the kubeconfig for the cluster suite: the one named, or the real home's default", () => {
        assert.equal(inside({ JIG_IT_KUBE_CONTEXT: "kind-jigit" }).KUBECONFIG, "/home/someone/.kube/config");
        assert.equal(
            inside({ JIG_IT_KUBE_CONTEXT: "kind-jigit", KUBECONFIG: "/tmp/kube.yaml" }).KUBECONFIG,
            "/tmp/kube.yaml",
        );
    });
});
