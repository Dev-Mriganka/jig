// Which addresses a request may go to. Everything is https; plain http is for 127.0.0.1 and localhost when the configuration
// allows it; link-local and cloud-metadata addresses are never called, in any spelling.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addressProblem } from "../src/engine/address.ts";

describe("https and plain http", () => {
    test("https is accepted, with a port, a path and a query", () => {
        assert.equal(addressProblem("https://api.example.test", false), undefined);
        assert.equal(addressProblem("https://api.example.test:8443/x?y=1", false), undefined);
        assert.equal(addressProblem("https://10.0.0.5/x", false), undefined, "a private network is the team's own");
        assert.equal(addressProblem("https://[2001:db8::1]/x", false), undefined);
    });

    test("plain http is for 127.0.0.1 and localhost, and only when the configuration allows it", () => {
        assert.equal(addressProblem("http://127.0.0.1:8080", true), undefined);
        assert.equal(addressProblem("http://localhost", true), undefined);
        assert.equal(addressProblem("http://LOCALHOST:3000/x", true), undefined);
        assert.match(
            addressProblem("http://127.0.0.1", false) ?? "",
            /^is this machine, which needs "allowPlainLocal": true in the api section$/,
        );
        assert.match(addressProblem("http://localhost:3000", false) ?? "", /needs "allowPlainLocal": true/);
    });

    test("this machine is refused over https too, unless the configuration allows it", () => {
        assert.match(addressProblem("https://127.0.0.1/x", false) ?? "", /needs "allowPlainLocal": true/);
        assert.match(addressProblem("https://localhost/x", false) ?? "", /needs "allowPlainLocal": true/);
        assert.equal(addressProblem("https://localhost/x", true), undefined);
    });

    test("any other plain http address is refused, with or without the flag", () => {
        for (const address of [
            "http://api.example.test",
            "http://10.0.0.1",
            "http://[2001:db8::1]/",
            "http://127.0.0.1.example.test",
            "http://localhost.example.test",
        ]) {
            for (const flag of [false, true])
                assert.match(
                    addressProblem(address, flag) ?? "",
                    /^must be an https address/,
                    `${address} with ${flag}`,
                );
        }
    });

    test("anything that is not a web address is refused", () => {
        for (const address of [
            "ftp://api.example.test",
            "ws://127.0.0.1",
            "file:///etc/hosts",
            "api.example.test",
            "//api.example.test",
            "/v1",
            "",
            "https://",
            "not a url",
            5,
            undefined,
            null,
            {},
        ]) {
            for (const flag of [false, true])
                assert.notEqual(addressProblem(address, flag), undefined, `${String(address)} with ${flag}`);
        }
    });

    test("a user name or a password in the address is refused", () => {
        assert.equal(
            addressProblem("https://jane:secret@api.example.test", false),
            "must not contain a user name or password",
        );
        assert.equal(
            addressProblem("https://jane@api.example.test", false),
            "must not contain a user name or password",
        );
    });
});

describe("addresses that are never called", () => {
    const never =
        /^is (?:a link-local or cloud metadata address|a cloud metadata address|a link-local address), which is never called$/;

    test("link-local addresses, in the 169.254.0.0/16 range", () => {
        for (const address of [
            "http://169.254.169.254/latest/meta-data/",
            "https://169.254.169.254/",
            "https://169.254.170.2/v2/credentials",
            "https://169.254.0.1/",
            "https://169.254.255.255/",
        ]) {
            for (const flag of [false, true])
                assert.match(addressProblem(address, flag) ?? "", never, `${address} with ${flag}`);
        }
        assert.equal(addressProblem("https://169.253.1.1/", false), undefined, "next to the range, and not in it");
    });

    test("the metadata addresses of other clouds", () => {
        for (const address of [
            "https://100.100.100.200/latest/meta-data/",
            "https://192.0.0.192/",
            "https://[fd00:ec2::254]/latest/meta-data/",
        ]) {
            assert.match(addressProblem(address, true) ?? "", never, address);
        }
    });

    test("the metadata names", () => {
        for (const name of [
            "metadata.google.internal",
            "metadata.goog",
            "metadata",
            "instance-data",
            "instance-data.ec2.internal",
            "METADATA.GOOGLE.INTERNAL",
            "metadata.google.internal.",
        ]) {
            assert.match(addressProblem(`https://${name}/computeMetadata/v1/`, true) ?? "", never, name);
        }
    });

    test("IPv6 link-local addresses, and IPv4 addresses written inside IPv6 ones", () => {
        for (const address of [
            "https://[fe80::1]/",
            "https://[FE80::abcd:1234]/",
            "https://[febf::1]/",
            "https://[::ffff:169.254.169.254]/",
            "https://[::ffff:a9fe:a9fe]/",
            "https://[64:ff9b::a9fe:a9fe]/",
            "https://[0:0:0:0:0:ffff:a9fe:a9fe]/",
        ]) {
            assert.match(addressProblem(address, true) ?? "", never, address);
        }
        assert.equal(addressProblem("https://[fec0::1]/", false), undefined, "fec0::/10 is not link-local");
    });

    test("the other spellings of an IPv4 address are the same address", () => {
        for (const address of [
            "https://2852039166/",
            "https://0xa9fea9fe/",
            "https://0251.0376.0251.0376/",
            "https://169.254.43518/",
            "https://0xA9.0xFE.0xA9.0xFE/",
        ]) {
            assert.match(addressProblem(address, true) ?? "", never, address);
        }
    });

    test("other forms of this machine are refused even when the configuration allows 127.0.0.1 and localhost", () => {
        for (const address of [
            "http://127.0.0.2/",
            "https://127.1.2.3/",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[::]/",
            "http://[::ffff:127.0.0.1]/",
            "http://foo.localhost/",
        ]) {
            assert.match(
                addressProblem(address, true) ?? "",
                /^is (?:this machine|a form of this machine other than 127\.0\.0\.1 and localhost), which (?:needs|is never called)|^is a form of this machine/,
                address,
            );
            assert.notEqual(addressProblem(address, true), undefined, address);
        }
        // 2130706433 is 127.0.0.1 written as one number: the same address, so the same rule.
        assert.notEqual(addressProblem("https://2130706433/", false), undefined);
        assert.equal(addressProblem("https://2130706433/", true), undefined);
    });

    test("the reason does not repeat the address", () => {
        assert.ok(!(addressProblem("https://169.254.169.254/secret-path", false) ?? "").includes("secret-path"));
    });
});
