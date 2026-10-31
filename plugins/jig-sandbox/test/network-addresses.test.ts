// What an address or a name is, for deciding whether a connection may leave the sandbox: the ranges that reach this machine and
// its neighbours, the metadata services, addresses written so that a program reads them as another, and host patterns.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    canonicalAddress,
    classifyHost,
    cleanHost,
    ownAddresses,
    parseIPv4,
    parseIPv6,
    rangeOf,
} from "../src/network/addresses.ts";
import { firstMatch, hostPort, matchesHost, parsePattern } from "../src/network/hosts.ts";

describe("the range of an IPv4 address", () => {
    const cases: Array<[string, ReturnType<typeof rangeOf>]> = [
        ["169.254.169.254", "metadata"],
        ["169.254.170.2", "metadata"],
        ["100.100.100.200", "metadata"],
        ["127.0.0.1", "loopback"],
        ["127.255.255.254", "loopback"],
        ["10.0.0.5", "private"],
        ["172.16.0.1", "private"],
        ["172.31.255.255", "private"],
        ["192.168.1.1", "private"],
        ["169.254.1.1", "link-local"],
        ["100.64.0.1", "carrier"],
        ["100.127.255.255", "carrier"],
        ["0.0.0.0", "unspecified"],
        ["224.0.0.1", "multicast"],
        ["255.255.255.255", "reserved"],
        ["240.0.0.1", "reserved"],
        ["192.0.2.7", "reserved"],
        ["198.18.0.1", "reserved"],
        ["172.15.0.1", undefined],
        ["172.32.0.1", undefined],
        ["100.63.0.1", undefined],
        ["100.128.0.1", undefined],
        ["8.8.8.8", undefined],
        ["93.184.216.34", undefined],
        ["192.169.0.1", undefined],
    ];
    for (const [address, range] of cases) {
        test(`${address} is ${range ?? "public"}`, () => assert.equal(rangeOf(address), range));
    }
});

describe("the range of an IPv6 address", () => {
    const cases: Array<[string, ReturnType<typeof rangeOf>]> = [
        ["::1", "loopback"],
        ["::", "unspecified"],
        ["fd00:ec2::254", "metadata"],
        ["fe80::1", "link-local"],
        ["fd12:3456::1", "private"],
        ["fc00::1", "private"],
        ["ff02::1", "multicast"],
        ["2001:db8::1", "reserved"],
        ["::ffff:127.0.0.1", "loopback"],
        ["::ffff:7f00:1", "loopback"],
        ["::ffff:169.254.169.254", "metadata"],
        ["::ffff:10.1.2.3", "private"],
        ["::ffff:8.8.8.8", undefined],
        ["64:ff9b::a00:1", "private"],
        ["64:ff9b::808:808", undefined],
        ["2002:7f00:1::", "loopback"],
        ["2002:0808:0808::", undefined],
        ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "reserved"],
        ["2606:4700:4700::1111", undefined],
        ["2a00:1450:4001:81b::200e", undefined],
    ];
    for (const [address, range] of cases) {
        test(`${address} is ${range ?? "public"}`, () => assert.equal(rangeOf(address), range));
    }

    test("parsing", () => {
        assert.deepEqual(parseIPv6("::1")?.slice(12), [0, 0, 0, 1]);
        assert.deepEqual(parseIPv6("1:2:3:4:5:6:7:8")?.slice(0, 4), [0, 1, 0, 2]);
        assert.deepEqual(parseIPv6("::ffff:1.2.3.4")?.slice(10), [255, 255, 1, 2, 3, 4]);
        assert.equal(parseIPv6("fe80::1%eth0"), undefined, "a zone is not accepted");
        assert.equal(parseIPv6("not an address"), undefined);
        assert.deepEqual(parseIPv4("1.2.3.4"), [1, 2, 3, 4]);
        assert.equal(parseIPv4("1.2.3"), undefined);
        assert.equal(parseIPv4("01.2.3.4"), undefined, "a leading zero is not a plain address");
    });
});

describe("this machine's own addresses", () => {
    test("are read from the interfaces, and an address of them is own even when it is also private", () => {
        const own = ownAddresses();
        assert.ok(own.length > 0);
        assert.ok(own.some((address) => address === "127.0.0.1"));
        const lan = new Set(
            ["192.168.1.50", "93.184.216.34", "2606:4700::5"].map((address) => canonicalAddress(address) as string),
        );
        assert.deepEqual(classifyHost("192.168.1.50", lan), { kind: "ip", address: "192.168.1.50", range: "own" });
        assert.deepEqual(classifyHost("93.184.216.34", lan), { kind: "ip", address: "93.184.216.34", range: "own" });
        assert.equal((classifyHost("2606:4700::5", lan) as { range: string }).range, "own");
        assert.equal((classifyHost("192.168.1.51", lan) as { range: string }).range, "private");
        assert.equal(
            (classifyHost("127.0.0.1", lan) as { range: string }).range,
            "loopback",
            "loopback stays loopback",
        );
        assert.equal(
            (classifyHost("169.254.169.254", new Set(["169.254.169.254"])) as { range: string }).range,
            "metadata",
            "a metadata address is never just own",
        );
    });
});

describe("a host as the proxy gives it", () => {
    test("is cleaned: case, brackets and a trailing dot", () => {
        assert.equal(cleanHost("  API.Example.COM. "), "api.example.com");
        assert.equal(cleanHost("[::1]"), "::1");
    });

    test("an address spelled another way is the same address", () => {
        assert.equal(canonicalAddress("::ffff:127.0.0.1"), "127.0.0.1");
        assert.equal(canonicalAddress("127.0.0.1"), "127.0.0.1");
        assert.equal(canonicalAddress("[::1]"), undefined, "brackets are cleaned first");
        assert.deepEqual(classifyHost("[::ffff:169.254.169.254]"), {
            kind: "ip",
            address: "169.254.169.254",
            range: "metadata",
        });
    });

    test("names: ordinary ones, the metadata ones and localhost", () => {
        assert.deepEqual(classifyHost("api.example.com"), {
            kind: "name",
            name: "api.example.com",
            metadata: false,
            localhost: false,
        });
        assert.equal((classifyHost("Metadata.Google.Internal") as { metadata: boolean }).metadata, true);
        assert.equal((classifyHost("metadata") as { metadata: boolean }).metadata, true);
        assert.equal((classifyHost("instance-data") as { metadata: boolean }).metadata, true);
        assert.equal((classifyHost("localhost") as { localhost: boolean }).localhost, true);
        assert.equal((classifyHost("app.localhost") as { localhost: boolean }).localhost, true);
        assert.equal((classifyHost("xn--bcher-kva.example") as { kind: string }).kind, "name");
    });

    test("an address with a zone is not judged by guessing", () => {
        for (const host of ["fe80::1%eth0", "[fe80::1%25eth0]", "::1%lo"])
            assert.equal(classifyHost(host).kind, "invalid", host);
    });

    test("spellings that some programs read as an address are not names", () => {
        for (const host of [
            "2130706433",
            "0x7f000001",
            "0x7f.0.0.1",
            "127.1",
            "0177.0.0.1",
            "1.2.3",
            "1.2.3.4.5",
            "a..b",
            "-a.com",
            "a-.com",
            "a_b.com",
            "",
            "a.b.1",
            "exa mple.com",
            "例え.jp",
            "a.com:80",
        ]) {
            assert.equal(classifyHost(host).kind, "invalid", host);
        }
    });

    test("a label or a name that is too long is invalid", () => {
        assert.equal(classifyHost(`${"a".repeat(64)}.com`).kind, "invalid");
        assert.equal(classifyHost(`${"a.".repeat(130)}com`).kind, "invalid");
    });
});

describe("host patterns", () => {
    test("a name, a wildcard, and an optional port", () => {
        assert.deepEqual(parsePattern("api.example.com"), {
            host: "api.example.com",
            wildcard: false,
            port: undefined,
        });
        assert.deepEqual(parsePattern("*.Example.com:443"), { host: "example.com", wildcard: true, port: 443 });
        for (const bad of [
            "",
            "*",
            "*.",
            "a b",
            "example.com:0",
            "example.com:70000",
            "http://example.com",
            "-x.com",
        ]) {
            assert.equal(parsePattern(bad), undefined, bad);
        }
    });

    test("a name matches itself, a wildcard matches subdomains and not the name, a port narrows", () => {
        const name = parsePattern("example.com") as NonNullable<ReturnType<typeof parsePattern>>;
        const wild = parsePattern("*.example.com") as NonNullable<ReturnType<typeof parsePattern>>;
        const port = parsePattern("example.com:443") as NonNullable<ReturnType<typeof parsePattern>>;
        assert.equal(matchesHost(name, "example.com", 80), true);
        assert.equal(matchesHost(name, "www.example.com", 80), false);
        assert.equal(matchesHost(wild, "www.example.com", 80), true);
        assert.equal(matchesHost(wild, "a.b.example.com", 80), true);
        assert.equal(matchesHost(wild, "example.com", 80), false);
        assert.equal(matchesHost(wild, "badexample.com", 80), false);
        assert.equal(matchesHost(port, "example.com", 443), true);
        assert.equal(matchesHost(port, "example.com", 80), false);
    });

    test("the first pattern that covers a host is returned; a bad one is skipped", () => {
        assert.equal(
            firstMatch(["nonsense!", "*.example.com", "example.com:443"], "api.example.com", 80),
            "*.example.com",
        );
        assert.equal(firstMatch(["example.com:443"], "example.com", 80), undefined);
        assert.equal(hostPort("::1", 80), "[::1]:80");
        assert.equal(hostPort("example.com", 443), "example.com:443");
    });
});
