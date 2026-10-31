// Which forge a repository is on, from origin's address and the `git` section of jig.json, as jig-git decides it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { forgeOf, parseRemoteAddress } from "../src/forge.ts";

describe("origin's address", () => {
    test("gives the host and the whole path, with any number of groups, in the forms git accepts", () => {
        for (const url of [
            "git@gitlab.example.com:platform/payments/orders-api.git",
            "https://gitlab.example.com/platform/payments/orders-api.git",
            "https://user@gitlab.example.com/platform/payments/orders-api/",
            "ssh://git@gitlab.example.com:2222/platform/payments/orders-api",
            "git://gitlab.example.com/platform/payments/orders-api.git",
        ]) {
            assert.deepEqual(
                parseRemoteAddress(url),
                { host: "gitlab.example.com", path: "platform/payments/orders-api" },
                url,
            );
        }
        assert.deepEqual(parseRemoteAddress("git@github.com:acme/orders-api.git"), {
            host: "github.com",
            path: "acme/orders-api",
        });
    });

    test("is nothing for a local path, a single name, or a part that could be read as an option or a step up", () => {
        for (const url of [
            undefined,
            "",
            "/srv/git/acme/orders-api.git",
            "../orders-api",
            "git@host:orders-api.git",
            "git@host:acme/../orders-api.git",
            "git@host:acme/-x/orders-api.git",
            "git@host:a b/c.git",
        ]) {
            assert.equal(parseRemoteAddress(url), undefined, String(url));
        }
    });
});

describe("the forge", () => {
    const at = (host: string, path = "platform/payments/orders-api") => ({ host, path });

    test("GitHub's hosts, and the configured clone host, are GitHub", () => {
        for (const host of ["github.com", "ssh.github.com", "github.com-work", "GitHub.com"]) {
            assert.deepEqual(forgeOf(at(host, "acme/orders-api"), undefined), { forge: "github" }, host);
        }
        assert.deepEqual(forgeOf(at("gh-alias", "acme/orders-api"), { cloneHost: "gh-alias" }), { forge: "github" });
    });

    test("gitlab.com and its alternate ssh host are GitLab on gitlab.com", () => {
        for (const host of ["gitlab.com", "altssh.gitlab.com"]) {
            assert.deepEqual(forgeOf(at(host), undefined), {
                forge: "gitlab",
                host: "gitlab.com",
                path: "platform/payments/orders-api",
            });
        }
    });

    test("a host in git.forges is what the setting says, however its name is cased", () => {
        const section = { forges: { "Gitlab.Example.com": "gitlab", "ghe.example.com": "github" } };
        assert.deepEqual(forgeOf(at("gitlab.example.com"), section), {
            forge: "gitlab",
            host: "gitlab.example.com",
            path: "platform/payments/orders-api",
        });
        assert.deepEqual(forgeOf(at("ghe.example.com", "acme/orders-api"), section), { forge: "github" });
    });

    test("an ssh alias mapped to the real host is told to gh and glab as that host; git keeps the alias", () => {
        assert.deepEqual(
            forgeOf(at("github.com-work", "acme/orders-api"), {
                forges: { "github.com-work": { forge: "github", host: "github.com" } },
            }),
            { forge: "github", repo: "github.com/acme/orders-api" },
        );
        assert.deepEqual(
            forgeOf(at("gl-work"), { forges: { "gl-work": { forge: "gitlab", host: "gitlab.example.com" } } }),
            { forge: "gitlab", host: "gitlab.example.com", path: "platform/payments/orders-api" },
        );
        assert.deepEqual(forgeOf(at("gl-work"), { forges: { "gl-work": { forge: "gitlab" } } }), {
            forge: "gitlab",
            host: "gl-work",
            path: "platform/payments/orders-api",
        });
    });

    test("any other host, and no host at all, stay on gh as they always did", () => {
        assert.deepEqual(forgeOf(at("git.example.com"), undefined), { forge: "github" });
        assert.deepEqual(forgeOf(undefined, { forges: { "git.example.com": "gitlab" } }), { forge: "github" });
    });

    test("a git section that is not in the shape is ignored", () => {
        for (const section of [null, "git", [], { forges: "gitlab" }, { forges: { "gitlab.example.com": 7 } }]) {
            assert.deepEqual(forgeOf(at("gitlab.example.com"), section), { forge: "github" }, JSON.stringify(section));
        }
    });
});
