// The `ci` entry of a service, and the `watch` and `artifacts` settings of the `ops` section: what is accepted, and what each
// mistake says. A message names its key and never repeats a value, because a secret pasted into the wrong place must not
// reach the model.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ciServicesOfRepo, findCiService, readOps, validateOps } from "../src/catalog.ts";
import type { Catalog } from "../src/catalog.ts";
import { DEFAULT_WATCH } from "../src/ci/settings.ts";
import { gitlabCi, jenkinsCi, section, withCi } from "./support/section.ts";
import type { Raw } from "./support/section.ts";

const errors = (ci: unknown, repo = "acme/orders-api"): string[] => {
    const raw = section();
    const entry = (raw.services as Record<string, Raw>)["orders-api"] as Raw;
    entry.ci = ci;
    entry.repo = repo;
    return validateOps(raw);
};

const catalog = (raw: Raw): Catalog => {
    const read = readOps(raw);
    assert.deepEqual(read.errors, []);
    return read.catalog as Catalog;
};

describe("a ci entry", () => {
    test("is read for each of the three systems, with the fields of its system", () => {
        assert.deepEqual(catalog(section()).services.get("orders-api")?.ci, {
            system: "github-actions",
            workflow: "build.yml",
        });
        assert.deepEqual(catalog(withCi(gitlabCi())).services.get("orders-api")?.ci, {
            system: "gitlab",
            url: CI_URL,
            project: "acme/orders-api",
            auth: { kind: "token", token: "env:GITLAB_TOKEN" },
            required: [],
        });
        assert.deepEqual(
            catalog(withCi(jenkinsCi({ required: ["Build", "Test"], environment: "staging" }))).services.get(
                "orders-api",
            )?.ci,
            {
                system: "jenkins",
                environment: "staging",
                url: CI_URL,
                job: "orders/build",
                auth: { kind: "basic", user: "ci-bot", token: "env:JENKINS_TOKEN" },
                required: ["Build", "Test"],
            },
        );
    });

    test("names one of the systems there are", () => {
        assert.deepEqual(errors({ system: "circleci" }), [
            "ops.services.orders-api.ci.system: unknown CI system; the systems there are: github-actions, gitlab, jenkins",
        ]);
        assert.deepEqual(errors({}), [
            "ops.services.orders-api.ci.system: required, the CI system: github-actions, gitlab, jenkins",
        ]);
        assert.match(errors("gitlab")[0] ?? "", /^ops\.services\.orders-api\.ci: must be an object with a system/);
    });

    test("GitHub Actions finds runs by repository, so the service needs a repo of the form owner/name", () => {
        assert.deepEqual(errors({ system: "github-actions" }, "acme/orders-api"), []);
        assert.match(
            errors({ system: "github-actions" }, "orders-api")[0] ?? "",
            /github-actions finds runs by repository, so the service needs repo/,
        );
        const raw = section();
        delete ((raw.services as Record<string, Raw>)["orders-api"] as Raw).repo;
        assert.match(validateOps(raw)[0] ?? "", /the service needs repo/);
        assert.match(
            errors({ system: "github-actions", workflow: "../x" })[0] ?? "",
            /workflow: must be a workflow file name/,
        );
        assert.match(
            errors({ system: "github-actions", url: "https://x.example.test" })[0] ?? "",
            /url: unknown field for github-actions/,
        );
    });

    test("an unknown field of a system is an error naming the system", () => {
        assert.deepEqual(errors(gitlabCi({ job: "x" })), ["ops.services.orders-api.ci.job: unknown field for gitlab"]);
        assert.deepEqual(errors(jenkinsCi({ project: "x" })), [
            "ops.services.orders-api.ci.project: unknown field for jenkins",
        ]);
    });

    test("GitLab needs an https address, a project and a sign-in", () => {
        assert.deepEqual(errors(gitlabCi()), []);
        for (const project of ["123", "acme/orders-api", "group/sub/orders-api"])
            assert.deepEqual(errors(gitlabCi({ project })), [], project);
        for (const project of ["", "a b", "acme/", "/x", "x".repeat(300), 5]) {
            assert.equal(errors(gitlabCi({ project })).length, 1, JSON.stringify(project));
        }
        assert.deepEqual(errors({ system: "gitlab", url: CI_URL, auth: { token: "env:T" } }), [
            "ops.services.orders-api.ci.project: required, a project id or a path such as acme/orders-api",
        ]);
        assert.match(
            errors(gitlabCi({ url: "http://gitlab.example.test" }))[0] ?? "",
            /url: must start with https:\/\/, because a credential travels/,
        );
        assert.match(
            errors(gitlabCi({ url: "https://user:pw@gitlab.example.test" }))[0] ?? "",
            /must not hold a user name or password: put them in auth/,
        );
        assert.match(
            errors(gitlabCi({ url: "https://gitlab.example.test/?a=1" }))[0] ?? "",
            /must not have a query string or a fragment/,
        );
        assert.match(errors(gitlabCi({ url: "nonsense" }))[0] ?? "", /url: must be an address/);
    });

    test("Jenkins needs an https address, a job with its folders, and a user with a token", () => {
        assert.deepEqual(errors(jenkinsCi()), []);
        for (const job of ["build", "orders/build", "a b/my job"])
            assert.deepEqual(errors(jenkinsCi({ job })), [], job);
        for (const job of ["", "/x", "a//b", "../x", ".hidden", "x".repeat(300), 5]) {
            assert.equal(errors(jenkinsCi({ job })).length, 1, JSON.stringify(job));
        }
        assert.match(errors(jenkinsCi({ job: undefined }))[0] ?? "", /job: required, the job with its folders/);
        assert.match(errors(jenkinsCi({ url: "http://jenkins.example.test" }))[0] ?? "", /must start with https:\/\//);
    });

    test("the sign-in is exactly one of a token, a sign-in service and a transport", () => {
        assert.deepEqual(errors(gitlabCi({ auth: { signIn: "corp" } })), []);
        assert.deepEqual(errors(jenkinsCi({ auth: { signIn: "corp" } })), []);
        assert.deepEqual(errors(gitlabCi({ auth: { transport: "corp" } })), []);
        assert.deepEqual(errors(jenkinsCi({ auth: { transport: "corp" } })), []);
        assert.deepEqual(errors(gitlabCi({ auth: {} })), [
            "ops.services.orders-api.ci.auth: needs exactly one of token, signIn or transport (found none)",
        ]);
        assert.deepEqual(errors(gitlabCi({ auth: undefined })), [
            "ops.services.orders-api.ci.auth: required, one of token, signIn or transport",
        ]);
        assert.match(
            errors(gitlabCi({ auth: { token: "env:T", signIn: "corp" } }))[0] ?? "",
            /needs exactly one of .* \(found token, signIn\)/,
        );
        assert.match(
            errors(jenkinsCi({ auth: { token: "env:T" } }))[0] ?? "",
            /auth\.user: required with token, a user name/,
        );
        assert.match(
            errors(jenkinsCi({ auth: { user: "a:b", token: "env:T" } }))[0] ?? "",
            /auth\.user: required with token/,
        );
        assert.match(errors(jenkinsCi({ auth: { user: "bot" } }))[0] ?? "", /auth\.token: must be a secret reference/);
        assert.match(errors(gitlabCi({ auth: { user: "bot", token: "env:T" } }))[0] ?? "", /auth\.user: unknown field/);
    });

    test("a token is a secret reference, and a message never repeats what was given", () => {
        const pasted = "glpat-SECRET-VALUE-0123456789";
        const found = errors(gitlabCi({ auth: { token: pasted } }));
        assert.deepEqual(found, [
            "ops.services.orders-api.ci.auth.token: must be a secret reference such as pass:ci/token, never the secret itself",
        ]);
        assert.ok(!JSON.stringify(found).includes(pasted));
        const url = errors(gitlabCi({ url: "https://bot:SECRET-PW@gitlab.example.test" }));
        assert.ok(!JSON.stringify(url).includes("SECRET-PW"));
    });

    test("through a transport the address may be plain http: the transport signs in, and no credential travels", () => {
        assert.deepEqual(errors(gitlabCi({ url: "http://127.0.0.1:8123", auth: { transport: "corp" } })), []);
        assert.match(
            errors(gitlabCi({ url: "ftp://x.example.test", auth: { transport: "corp" } }))[0] ?? "",
            /must start with http:\/\/ or https:\/\//,
        );
    });

    test("required is a list of at most 20 names, and a jig-core environment name is optional", () => {
        assert.deepEqual(errors(gitlabCi({ required: ["build", "test"], environment: "staging" })), []);
        assert.match(
            errors(gitlabCi({ required: "build" }))[0] ?? "",
            /required: must be a list of at most 20 job names/,
        );
        assert.match(
            errors(jenkinsCi({ required: Array.from({ length: 21 }, (_, i) => `s${i}`) }))[0] ?? "",
            /at most 20 stage names/,
        );
        assert.match(
            errors(gitlabCi({ environment: "Not Valid" }))[0] ?? "",
            /environment: must be the name of a jig-core environment/,
        );
    });
});

describe("the watch settings and the artifact rules", () => {
    test("have defaults, and the defaults are the ones jig-git had", () => {
        const read = catalog(section());
        assert.deepEqual(read.watch, DEFAULT_WATCH);
        assert.deepEqual(DEFAULT_WATCH, { auto: true, pollSeconds: 30, stallMinutes: 30, timeoutMinutes: 60 });
        assert.deepEqual(read.artifacts, []);
    });

    test("take the fields of ops.watch one by one", () => {
        const read = catalog(section({ watch: { auto: false, pollSeconds: 45 } }));
        assert.deepEqual(read.watch, { auto: false, pollSeconds: 45, stallMinutes: 30, timeoutMinutes: 60 });
    });

    test("name the key of each mistake", () => {
        assert.deepEqual(validateOps(section({ watch: "yes" })), ["ops.watch: must be an object"]);
        assert.deepEqual(validateOps(section({ watch: { pollSecs: 30 } })), ["ops.watch.pollSecs: unknown field"]);
        assert.deepEqual(validateOps(section({ watch: { auto: "yes" } })), ["ops.watch.auto: must be true or false"]);
        assert.deepEqual(validateOps(section({ watch: { pollSeconds: 1 } })), [
            "ops.watch.pollSeconds: must be a number from 5 to 3600",
        ]);
        assert.deepEqual(validateOps(section({ watch: { stallMinutes: 0 } })), [
            "ops.watch.stallMinutes: must be a number from 1 to 1440",
        ]);
        assert.deepEqual(validateOps(section({ watch: { timeoutMinutes: "60" } })), [
            "ops.watch.timeoutMinutes: must be a number from 1 to 1440",
        ]);
    });

    test("artifact rules have a kind and exactly one place to look", () => {
        const good = [
            { kind: "image", check: "build-image", log: "image: (\\S+)" },
            { kind: "image", comment: "image: (\\S+)", bot: "ci-bot" },
            { kind: "tag", tag: "^v1\\." },
            { kind: "release", tag: "^v1\\." },
        ];
        assert.deepEqual(catalog(section({ artifacts: good })).artifacts, good);
        const bad = (rule: unknown) => validateOps(section({ artifacts: [rule] }));
        assert.deepEqual(validateOps(section({ artifacts: "x" })), ["ops.artifacts: must be a list of rules"]);
        assert.deepEqual(bad("x"), ["ops.artifacts[0]: must be an object"]);
        assert.ok(
            bad({ kind: "deb", check: "b" }).includes("ops.artifacts[0].kind: must be one of image, tag, release"),
        );
        assert.ok(
            bad({ kind: "image" }).includes(
                "ops.artifacts[0]: needs exactly one of check, comment and tag (found none)",
            ),
        );
        assert.ok(bad({ kind: "image", check: "b", tag: "x" }).some((line) => /found check, tag/.test(line)));
        assert.ok(
            bad({ kind: "image", log: "x" }).includes(
                "ops.artifacts[0].log: needs check, it is read from that job's log",
            ),
        );
        assert.ok(bad({ kind: "image", comment: "x", bot: "" }).includes("ops.artifacts[0].bot: must be a login"));
        assert.ok(
            bad({ kind: "image", tag: "x" }).includes(
                "ops.artifacts[0].tag: names tags or releases, so kind must be tag or release",
            ),
        );
        assert.match(
            bad({ kind: "tag", tag: "(" })[0] ?? "",
            /ops\.artifacts\[0\]\.tag: not a valid regular expression/,
        );
        assert.ok(bad({ kind: "tag", tag: "x", color: 1 }).includes("ops.artifacts[0].color: unknown field"));
    });
});

describe("finding the service of a ci call", () => {
    const read = catalog(section());

    test("returns the service with its ci entry", () => {
        const found = findCiService(read, "ci", "orders-api");
        assert.deepEqual(
            [found.name, found.repo, found.ci.system],
            ["orders-api", "acme/orders-api", "github-actions"],
        );
    });

    test("an unknown service, or one with no ci entry, is invalid input and the message lists the ones there are", () => {
        assert.throws(
            () => findCiService(read, "ci", "nope"),
            (error: unknown) => {
                assert.ok(error instanceof TypeError);
                assert.equal(
                    error.message,
                    'ci: no service named "nope". Services with a ci entry: orders-api (github-actions)',
                );
                return true;
            },
        );
        assert.throws(
            () => findCiService(read, "ci", "billing"),
            /^InputError: ci: billing has no ci entry in the catalog\. Services with a ci entry: orders-api \(github-actions\)$/,
        );
        assert.throws(() => findCiService(read, "ci", 5), /no service named 5/);
    });

    test("services of a repository are found whatever the case of its name, and only those with a ci entry", () => {
        const raw = section();
        (raw.services as Record<string, Raw>).billing = {
            repo: "acme/orders-api",
            environments: { staging: { health: "https://b.example.test/h" } },
        };
        const both = catalog(raw);
        assert.deepEqual(
            ciServicesOfRepo(both, "ACME/Orders-API").map((service) => service.name),
            ["orders-api"],
        );
        assert.deepEqual(ciServicesOfRepo(both, "acme/other"), []);
    });
});

const CI_URL = "https://ci.example.test";
