// The local-pointer check: text for Jira is read by people who do not have this machine, so a path on it, a file link or
// the name of a private folder is flagged in the preview. It flags and never blocks.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { flagLines, pointersIn, stringsIn } from "../src/pointers.ts";

describe("local paths", () => {
    test("every kind the README names is flagged", () => {
        assert.deepEqual(pointersIn(["Notes are in /home/alice/notes/login.md"]), [
            "local path: /home/alice/notes/login.md",
        ]);
        assert.deepEqual(pointersIn(["see /Users/bob/dev/app/README.md."]), [
            "local path: /Users/bob/dev/app/README.md",
        ]);
        assert.deepEqual(pointersIn(["run ~/bin/check.sh first"]), ["local path: ~/bin/check.sh"]);
        assert.deepEqual(pointersIn([String.raw`the log is C:\Users\carol\logs\app.log`]), [
            String.raw`local path: C:\Users\carol\logs\app.log`,
        ]);
        assert.deepEqual(pointersIn(["or D:/work/export.csv"]), ["local path: D:/work/export.csv"]);
        assert.deepEqual(pointersIn(["open file:///etc/hosts now"]), ["file link: file:///etc/hosts"]);
        assert.deepEqual(pointersIn(["run ./scripts/run.sh and ../shared/config.yml"]), [
            "relative path: ./scripts/run.sh",
            "relative path: ../shared/config.yml",
        ]);
    });

    test("the folders of a Linux or WSL scratch space are local too", () => {
        assert.deepEqual(pointersIn(["output in /tmp/out.json and /mnt/c/Users/dan/report.xlsx"]), [
            "local path: /tmp/out.json",
            "local path: /mnt/c/Users/dan/report.xlsx",
        ]);
    });

    test("a path in quotes, brackets or code ends where the quote or bracket does", () => {
        assert.deepEqual(
            pointersIn([`cat "/home/alice/a b.txt" and (see /home/alice/c.txt) and {{/home/alice/d.txt}}`]),
            ["local path: /home/alice/a", "local path: /home/alice/c.txt", "local path: /home/alice/d.txt"],
        );
    });

    test("a path inside a web address, or part of a longer word or path, is not a pointer", () => {
        assert.deepEqual(
            pointersIn([
                "https://example.test/home/page and https://example.test/Users/guide and https://example.test:8080/home/x",
                "https://example.test/a/./b and https://example.test/docs/../x and org/home/alice and a-/home/x",
                "and/or, Done./Next, v1.2.3, 1./2, a/b/c, it's 10:30/11:00, ...",
            ]),
            [],
        );
    });

    test("the same pointer found twice is listed once, and every text is checked", () => {
        assert.deepEqual(pointersIn(["/home/alice/a.md", "again /home/alice/a.md", "and ~/b.md"]), [
            "local path: /home/alice/a.md",
            "local path: ~/b.md",
        ]);
    });

    test("a long path is shortened in the flag", () => {
        const [flag = ""] = pointersIn([`/home/alice/${"deep/".repeat(40)}file.md`]);
        assert.ok(flag.length <= "local path: ".length + 80, flag);
        assert.ok(flag.endsWith("..."));
    });

    test("a real comment that points at the agent's workspace", () => {
        const flags = pointersIn([
            [
                "h3. Findings",
                "I compared the exports (see /home/alice/work/PROJ-1/evidence/export.csv).",
                "The query is saved in ./queries/export.sql and the notes are in ~/notes/proj-1.md.",
                "Upstream docs: https://docs.example.test/home/export.",
            ].join("\n"),
        ]);
        assert.deepEqual(flags, [
            "local path: /home/alice/work/PROJ-1/evidence/export.csv",
            "local path: ~/notes/proj-1.md",
            "relative path: ./queries/export.sql",
        ]);
    });
});

describe("private names", () => {
    test("a name is flagged without regard to case, and only as a whole word", () => {
        assert.deepEqual(pointersIn(["Ask Payroll about it"], ["payroll"]), ["private name: payroll"]);
        assert.deepEqual(pointersIn(["payrolling, prepayroll_x and xpayroll"], ["payroll"]), []);
        assert.deepEqual(pointersIn(["the host build-box-2 is down"], ["build-box"]), ["private name: build-box"]);
    });

    test("a host name with dots and a name with regular-expression characters are taken literally", () => {
        assert.deepEqual(pointersIn(["reach corp.example.net or a+b (c)"], ["corp.example.net", "a+b (c)"]), [
            "private name: corp.example.net",
            "private name: a+b (c)",
        ]);
        assert.deepEqual(pointersIn(["corpXexampleXnet"], ["corp.example.net"]), []);
    });

    test("with no private names only paths are flagged", () => {
        assert.deepEqual(pointersIn(["payroll"], []), []);
    });
});

describe("helpers", () => {
    test("stringsIn finds every string in a value, however deep", () => {
        assert.deepEqual(stringsIn({ a: "one", b: ["two", { c: "three", d: 4 }], e: null, f: { g: ["four"] } }), [
            "one",
            "two",
            "three",
            "four",
        ]);
        assert.deepEqual(stringsIn("x"), ["x"]);
        assert.deepEqual(stringsIn(5), []);
    });

    test("flagLines lists the first eight and counts the rest", () => {
        const flags = Array.from({ length: 11 }, (_, index) => `local path: /home/a/${index}`);
        assert.deepEqual(flagLines(flags.slice(0, 8)), flags.slice(0, 8));
        assert.deepEqual(flagLines(flags), [...flags.slice(0, 8), "and 3 more"]);
    });
});
