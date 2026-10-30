// A file a request uploads must sit inside its collection's folder, after following links. The folder of a Postman collection is
// the one its file is in, and the folder of a `.http` collection is the folder itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { acmeSection } from "./support/acme.ts";
import { ok, setupHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

let h: Harness;
before(async () => {
    h = await setupHarness();
});
after(() => h.close());

let root: string;
let outside: string;
beforeEach(() => {
    h.reset();
    // The collection lives in `root`; `outside` is a sibling folder that no request may reach.
    root = path.join(h.dir, "collection");
    outside = path.join(h.dir, "elsewhere");
    fs.mkdirSync(path.join(root, "files"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, "files", "inside.txt"), "inside the collection");
    fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-CANARY");
});

/** A Postman collection with one request that uploads `src` as a form file, and one that sends it as the whole body. */
function postman(src: string): void {
    const file = path.join(root, "c.postman_collection.json");
    const url = { raw: "{{baseUrl}}/up" };
    fs.writeFileSync(file, JSON.stringify({
        info: { name: "Uploads" },
        item: [
            { name: "Form", request: { method: "POST", url, body: { mode: "formdata", formdata: [{ key: "f", type: "file", src }] } } },
            { name: "Body", request: { method: "PUT", url, body: { mode: "file", file: { src } } } },
        ],
    }));
    const env = path.join(root, "staging.json");
    fs.writeFileSync(env, JSON.stringify({ values: [{ key: "baseUrl", value: h.api.origin, enabled: true }] }));
    h.configure({ collections: { up: { postman: file, environments: { Staging: env } } }, environments: { Staging: "staging" }, allowPlainLocal: true });
}

function httpFile(include: string): void {
    fs.writeFileSync(path.join(root, "up.http"), `PUT {{baseUrl}}/up\nContent-Type: text/plain\n\n< ${include}\n`);
    fs.writeFileSync(path.join(root, "http-client.env.json"), JSON.stringify({ staging: { baseUrl: h.api.origin } }));
    h.configure({ collections: { up: { http: root } }, environments: { staging: "staging" }, allowPlainLocal: true });
}

const upload = (request: string, environment = "Staging") => h.call({ action: "run", request, collection: "up", environment });
const refusal = (_name: string, src: string, why: string): string => `jig-core could not decide: the file ${JSON.stringify(src)} ${why}`;
const OUTSIDE = "is outside the collection's folder (after following links), and a request may only use files inside it";

describe("a file inside the collection's folder", () => {
    test("is uploaded, as a form field and as a whole body", async () => {
        postman("files/inside.txt");
        ok(await upload("Form"));
        assert.match(h.api.requests[0]?.body ?? "", /filename="inside\.txt"[\s\S]*inside the collection/);
        ok(await upload("Body"));
        assert.equal(h.api.requests[1]?.body, "inside the collection");
    });

    test("may be written with an absolute path, if it is inside, and with a path that goes up and comes back", async () => {
        postman(path.join(root, "files", "inside.txt"));
        ok(await upload("Body"));
        postman("files/../files/./inside.txt");
        ok(await upload("Body"));
        assert.deepEqual(h.api.requests.map((r) => r.body), ["inside the collection", "inside the collection"]);
    });

    test("in a .http collection too", async () => {
        httpFile("./files/inside.txt");
        ok(await upload("up.http#1", "staging"));
        assert.equal(h.api.requests[0]?.body, "inside the collection");
    });
});

describe("a file outside it", () => {
    test("is refused, written as a relative path or an absolute one", async () => {
        for (const src of ["../elsewhere/secret.txt", path.join(outside, "secret.txt"), "files/../../elsewhere/secret.txt", "/etc/hostname"]) {
            postman(src);
            for (const request of ["Form", "Body"]) {
                const result = await upload(request);
                assert.equal(result.blocked, refusal(request, src, OUTSIDE), `${request} ${src}`);
            }
        }
        httpFile("../elsewhere/secret.txt");
        assert.equal((await upload("up.http#1", "staging")).blocked, refusal("up.http#1", "../elsewhere/secret.txt", OUTSIDE));
        assert.equal(h.api.requests.length, 0);
    });

    test("is refused when a link inside the folder leads to it, whether the link is to the file or to the folder it is in", async () => {
        fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "files", "linked.txt"));
        fs.symlinkSync(outside, path.join(root, "linked-folder"));
        for (const src of ["files/linked.txt", "linked-folder/secret.txt"]) {
            postman(src);
            for (const request of ["Form", "Body"]) assert.equal((await upload(request)).blocked, refusal(request, src, OUTSIDE), `${request} ${src}`);
        }
        httpFile("./files/linked.txt");
        assert.equal((await upload("up.http#1", "staging")).blocked, refusal("up.http#1", "./files/linked.txt", OUTSIDE));
        assert.equal(h.api.requests.length, 0);
        assert.ok(!JSON.stringify(h.api.requests).includes("OUTSIDE-CANARY"));
    });

    test("is refused when the folder of the collection is itself reached through a link, and the file is outside the real one", async () => {
        const alias = path.join(h.dir, "alias");
        fs.symlinkSync(root, alias);
        const file = path.join(alias, "c.postman_collection.json");
        postman("files/inside.txt");
        const moved = JSON.parse(fs.readFileSync(path.join(root, "c.postman_collection.json"), "utf8")) as unknown;
        fs.writeFileSync(file, JSON.stringify(moved));
        const section = h.jig.api.config.section("api") as { collections: { up: { postman: string } } };
        section.collections.up.postman = file;
        h.configure({ ...section, collections: { up: { ...section.collections.up, postman: file } } });
        ok(await upload("Body"));
        postman("../elsewhere/secret.txt");
        assert.match((await upload("Body")).blocked ?? "", /is outside the collection's folder/);
    });

    test("a link that stays inside is fine", async () => {
        fs.symlinkSync(path.join(root, "files", "inside.txt"), path.join(root, "alias.txt"));
        postman("alias.txt");
        ok(await upload("Body"));
        assert.equal(h.api.requests[0]?.body, "inside the collection");
    });
});

describe("a file that cannot be used", () => {
    test("a file that is not there, a folder, and a file that is too large are refused with the reason", async () => {
        postman("files/missing.txt");
        assert.equal((await upload("Body")).blocked, refusal("Body", "files/missing.txt", "no such file"));
        postman("files");
        assert.equal((await upload("Body")).blocked, refusal("Body", "files", "is a folder, not a file"));
        fs.writeFileSync(path.join(root, "files", "big.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
        postman("files/big.bin");
        assert.equal((await upload("Body")).blocked, refusal("Body", "files/big.bin", "is larger than 10 MiB"));
        assert.equal(h.api.requests.length, 0);
    });
});

describe("what the person approves", () => {
    test("is the file's name, size and digest, not its content; and a file that changed since the preview is not sent", async () => {
        postman("files/inside.txt");
        const first = await upload("Body");
        assert.match(first.preview?.body ?? "", /<file inside\.txt, 21 bytes, sha256 [0-9a-f]{12}>/);
        assert.ok(!(first.preview?.body ?? "").includes("inside the collection"), "the content is not in the preview");
        ok(first);
        const changed = await h.call({ action: "run", request: "Body", collection: "up", environment: "Staging" }, {
            between: () => fs.writeFileSync(path.join(root, "files", "inside.txt"), "changed while you read it"),
        });
        assert.equal(changed.error?.message, 'api run "Body": changed since the preview; run it again to see the new preview. Nothing was sent.');
        assert.equal(h.api.requests.length, 1, "only the first one was sent");
        // The file is the new one on the next run, and its preview shows the new digest.
        const next = await upload("Body");
        assert.notEqual(next.preview?.fingerprint, first.preview?.fingerprint);
        ok(next);
        assert.equal(h.api.requests[1]?.body, "changed while you read it");
    });

    test("an upload is not carried by a transport, which holds a text body only", async () => {
        postman("files/inside.txt");
        h.jig.transports.set("company-proxy", { request: async () => ({ status: 200, headers: {}, body: "{}" }) });
        h.configure({ ...(h.jig.api.config.section("api") as Record<string, unknown>), environments: { Staging: { environment: "staging", transport: "company-proxy" } } });
        const result = await upload("Body");
        assert.equal(result.error?.message, 'api run "Body": a transport carries a text body, and not a file or a multipart form. Nothing was sent.');
        assert.equal(h.jig.transportCalls.length, 0);
    });
});

describe("the fixtures", () => {
    test("the example company's request for a file outside its folder is refused", async () => {
        h.configure(acmeSection(h));
        const postmanResult = await h.call({ action: "run", request: "Upload outside", collection: "acme", environment: "Staging", variables: { orderId: "1" } });
        assert.equal(postmanResult.blocked, refusal("Upload outside", "../outside.txt", OUTSIDE));
        const httpResult = await h.call({ action: "run", request: "Upload outside", collection: "ledger", environment: "staging" });
        assert.equal(httpResult.blocked, refusal("Upload outside", "../outside.txt", OUTSIDE));
        assert.equal(h.api.requests.length, 0);
    });
});
