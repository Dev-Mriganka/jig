// What the code of the ci tool is allowed to contain. The model supplies a service and a few checked values; the catalog
// supplies every address, project, job and credential; and a write is sent from one place each, once. These tests read the
// sources, because a call cannot show that a path does not exist.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { codeOf, sources } from "./support/sources.ts";

const all = sources();
const where = (pattern: RegExp) => all.filter(({ text }) => pattern.test(codeOf(text))).map(({ file }) => file);
const code = (file: string) => codeOf(all.find((source) => source.file === file)?.text ?? "");
const occurrences = (file: string, pattern: RegExp) => [...code(file).matchAll(pattern)].length;

describe("the requests the adapters make", () => {
    test("leave this process in one file: the network, the transports, the secrets and the sign-in services", () => {
        assert.deepEqual(
            where(/\bfetch(?:Impl)?\(/).filter((file) => file.startsWith("ci/")),
            ["ci/request.ts"],
        );
        assert.deepEqual(where(/transports\.request\(/), ["ci/request.ts"]);
        assert.deepEqual(where(/secrets\.resolve\(/), ["ci/request.ts"]);
        assert.deepEqual(where(/signIn\.headers\(/), ["ci/request.ts"]);
    });

    test("never follow a redirect, because it would carry the credential to an address the catalog never named", () => {
        assert.match(code("ci/request.ts"), /redirect: "manual"/);
        assert.deepEqual(where(/redirect:\s*"follow"/), []);
    });

    test("only ever read, or POST: no other method exists", () => {
        assert.match(code("ci/request.ts"), /method: "GET" \| "POST"/);
        assert.deepEqual(where(/["'`](?:PUT|PATCH|DELETE)["'`]/), []);
        assert.deepEqual(where(/method: "POST"/), ["ci/gitlab-api.ts", "ci/jenkins-api.ts"]);
    });

    test("add the credential in that file only: a header name of a sign-in is written once", () => {
        assert.deepEqual(where(/PRIVATE-TOKEN/), ["ci/request.ts"]);
        assert.deepEqual(where(/authorization: `Basic/), ["ci/request.ts"]);
    });

    test("take the address from the catalog: no adapter writes a host of its own", () => {
        assert.deepEqual(
            where(/https?:\/\/[a-z]/i).filter((file) => file.startsWith("ci/") && !file.endsWith("config.ts")),
            [],
        );
    });
});

describe("the writes", () => {
    test("GitHub has one: gh run rerun, sent through ghWrite, which never repeats it", () => {
        assert.deepEqual(where(/ghWrite\(/), ["ci/gh.ts", "ci/github-actions.ts"]);
        assert.equal(occurrences("ci/github-actions.ts", /ghWrite\(/g), 1);
        assert.match(code("ci/github-actions.ts"), /ghWrite\(\s*"gh run rerun"/);
    });

    test("GitLab has two, each sent once: the retry of a pipeline and the creation of one", () => {
        assert.equal(occurrences("ci/gitlab.ts", /api\.post\(/g), 2);
        assert.match(code("ci/gitlab.ts"), /api\.post\(`\/pipelines\/\$\{id\}\/retry`\)/);
        assert.match(code("ci/gitlab.ts"), /api\.post\("\/pipeline"/);
    });

    test("Jenkins has one, sent once, after a crumb that was asked for before anything was sent", () => {
        assert.equal(occurrences("ci/jenkins.ts", /api\.start\(/g), 1);
        assert.ok(code("ci/jenkins.ts").indexOf("await api.crumb()") < code("ci/jenkins.ts").indexOf("api.start("));
    });

    test("none is sent again by a retry loop: the adapters have no loop around a send", () => {
        for (const file of ["ci/gitlab.ts", "ci/jenkins.ts", "ci/github-actions.ts", "ci/request.ts", "ci/lost.ts"]) {
            assert.doesNotMatch(code(file), /\b(?:while|for)\s*\([^)]*\)\s*\{[^}]*(?:post|start|ghWrite)\(/, file);
        }
    });

    test("the tool sends a plan only after comparing it with the preview the user approved", () => {
        assert.match(code("ci/tool.ts"), /checkUnchanged\(toolCallId, call, planned\);\s*return planned\.send\(\);/);
        assert.equal(occurrences("ci/tool.ts", /\.send\(\)/g), 1);
        assert.deepEqual(where(/\.send\(\)/), ["ci/tool.ts"]);
    });

    test("every send ends a lost reply with one read and no second send", () => {
        for (const file of ["ci/gitlab.ts", "ci/jenkins.ts", "ci/github-actions.ts"])
            assert.match(code(file), /afterLostReply\(/, file);
        assert.doesNotMatch(code("ci/lost.ts"), /post|start|ghWrite|send/);
    });
});

describe("the watch", () => {
    test("is started from the tool and from the push listener, and nowhere else", () => {
        assert.deepEqual(
            where(/watches\.start\(/).filter((file) => file.startsWith("ci/")),
            ["ci/autowatch.ts", "ci/tool.ts"],
        );
    });

    test("reads the catalog when it polls: no spec field holds an address, a project or a credential", () => {
        for (const file of ["ci/github-watch.ts", "ci/gitlab-watch.ts", "ci/jenkins-watch.ts"]) {
            const interfaces = code(file).match(/export interface \w+Spec \{[^}]*\}/s)?.[0] ?? "";
            assert.ok(interfaces.length > 0, file);
            assert.doesNotMatch(interfaces, /\b(?:url|project|job|repo|token|auth)\b/, file);
        }
    });

    test("publishes the artifact event under the name jig-ops owns", () => {
        assert.deepEqual(where(/jig-git:artifact-ready/), []);
        assert.match(code("ci/artifacts.ts"), /"jig-ops:artifact-ready"/);
    });

    test("listens for the push by the name jig-git publishes it under", () => {
        assert.match(code("ci/autowatch.ts"), /PUSHED_EVENT = "jig-git:pushed"/);
        assert.deepEqual(where(/jig-git\/src|from "\.\.\/\.\.\/\.\.\/jig-git/), []);
    });
});
