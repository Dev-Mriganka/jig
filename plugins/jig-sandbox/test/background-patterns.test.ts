// The patterns that wake the agent: which are refused before a task starts, and how lines are matched.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LineEndings } from "../src/background/tasks.ts";
import { LineMatcher, MAX_PATTERN_CHARS, patternProblem, screenPatterns } from "../src/background/patterns.ts";
import type { Match } from "../src/background/patterns.ts";

describe("which patterns are refused", () => {
    test("ordinary patterns are fine", () => {
        for (const source of [
            "Listening on",
            "ERROR|Exception",
            "ready in \\d+ ms",
            "^\\s*at .*\\(",
            "(foo|bar)+",
            "(\\d{1,3}\\.){3}\\d{1,3}",
            "BUILD (SUCCESSFUL|FAILED)",
            "Started \\w+ in [0-9.]+ seconds",
            "[a-z]+:\\d+",
        ]) {
            assert.equal(patternProblem(source), undefined, source);
        }
    });

    test("a back-reference is refused", () => {
        assert.match(patternProblem("(a)\\1") ?? "", /back-reference/);
        assert.match(patternProblem("(?<word>a)\\k<word>") ?? "", /back-reference/);
        assert.equal(patternProblem("[\\1]x"), undefined, "inside a class it is not one");
    });

    test("a look-behind is refused, a look-ahead is not", () => {
        assert.match(patternProblem("(?<=a)b") ?? "", /look-behind/);
        assert.match(patternProblem("(?<!a)b") ?? "", /look-behind/);
        assert.equal(patternProblem("a(?=b)"), undefined);
        assert.equal(patternProblem("(?<name>a)b"), undefined, "a named group is not a look-behind");
    });

    test("a repeat inside a repeat is refused", () => {
        for (const source of [
            "(a+)+",
            "(a*)*",
            "(.*)+x",
            "(\\w+\\s?)+",
            "(a|b+)*",
            "((a+)b)+",
            "(a+){2,}",
            "(?:a+)+",
        ]) {
            assert.match(patternProblem(source) ?? "", /repeat inside a repeat/, source);
        }
    });

    test("a repeat next to a repeat, or inside a bounded group, is fine", () => {
        for (const source of ["a+b+", "(a+)b", "(a+)\\s(b+)", "(a+)?b", "(\\d+,){3}", "(ab)+c*"]) {
            assert.equal(patternProblem(source), undefined, source);
        }
    });

    test("a count over a thousand is refused", () => {
        assert.match(patternProblem("a{1,100000}") ?? "", /1,000/);
        assert.match(patternProblem("a{5000}") ?? "", /1,000/);
        assert.equal(patternProblem("a{1,1000}"), undefined);
    });

    test("a pattern that is empty, too long, broken or matches an empty line is refused", () => {
        assert.match(patternProblem("") ?? "", /empty/);
        assert.match(patternProblem("a".repeat(MAX_PATTERN_CHARS + 1)) ?? "", /longer than 200/);
        assert.match(patternProblem("(unclosed") ?? "", /not a valid regular expression/);
        assert.match(patternProblem(".*") ?? "", /matches an empty line/);
        assert.match(patternProblem("a\nb") ?? "", /control character/);
    });

    test("the list: at most five, each text, and the first problem names its place", () => {
        assert.equal(screenPatterns("ready", undefined), undefined);
        assert.equal(screenPatterns("ready", ["a", "b"]), undefined);
        assert.match(screenPatterns("ready", ["a", "b", "c", "d", "e", "f"]) ?? "", /at most 5/);
        assert.match(screenPatterns("error", "x") ?? "", /list of regular expressions/);
        assert.match(screenPatterns("error", [5]) ?? "", /notifyOn\.error\[0\] must be text/);
        assert.match(screenPatterns("error", ["ok", "(a+)+"]) ?? "", /notifyOn\.error\[1\] \(\(a\+\)\+\) is refused/);
    });

    test("a slow pattern does not stall the matcher: only the start of a long line is matched", () => {
        const found: Match[] = [];
        const matcher = new LineMatcher({ ready: [], error: ["x{1,50}y"], onMatch: (match) => found.push(match) });
        const started = performance.now();
        matcher.push(Buffer.from(`${"x".repeat(200_000)}\n`), 0);
        assert.ok(performance.now() - started < 500);
        assert.equal(found.length, 0);
        matcher.dispose();
    });
});

describe("matching lines", () => {
    function collect(ready: string[], error: string[], idleMs = 20) {
        const found: Match[] = [];
        const matcher = new LineMatcher({ ready, error, idleMs, onMatch: (match) => found.push(match) });
        return { matcher, found };
    }

    test("a line is matched as a whole, with the offset where it starts", () => {
        const { matcher, found } = collect(["Listening on"], ["ERROR"]);
        matcher.push(Buffer.from("starting\nListening on :8080\nERROR boom\n"), 100);
        assert.deepEqual(
            found.map((match) => [match.kind, match.pattern, match.line, match.offset]),
            [
                ["ready", "Listening on", "Listening on :8080", 109],
                ["error", "ERROR", "ERROR boom", 128],
            ],
        );
        matcher.dispose();
    });

    test("a line cut between two chunks is matched once, whole", () => {
        const { matcher, found } = collect([], ["ERROR \\d+"]);
        matcher.push(Buffer.from("ERR"), 0);
        matcher.push(Buffer.from("OR 4"), 3);
        matcher.push(Buffer.from("2\n"), 7);
        assert.equal(found.length, 1);
        assert.equal(found[0]?.line, "ERROR 42");
        matcher.dispose();
    });

    test("ready matches once; error matches every time", () => {
        const { matcher, found } = collect(["up"], ["bad"]);
        matcher.push(Buffer.from("up\nup\nbad\nbad\n"), 0);
        assert.deepEqual(
            found.map((match) => match.kind),
            ["ready", "error", "error"],
        );
        matcher.dispose();
    });

    test("a carriage return ends a line, so a progress meter and a prompt count", () => {
        const { matcher, found } = collect([], ["100%"]);
        matcher.push(Buffer.from("10%\r50%\r100%\r"), 0);
        assert.equal(found.length, 1);
        assert.equal(found[0]?.line, "100%");
        matcher.dispose();
    });

    test("a prompt with no newline is matched after a pause", async () => {
        const { matcher, found } = collect(["Continue\\? \\[y/N\\]"], []);
        matcher.push(Buffer.from("Continue? [y/N]"), 0);
        assert.equal(found.length, 0);
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(found.length, 1);
        matcher.dispose();
    });

    test("flush matches what is held, and a disposed matcher says nothing more", async () => {
        const { matcher, found } = collect([], ["tail"]);
        matcher.push(Buffer.from("the tail"), 0);
        matcher.flush();
        assert.equal(found.length, 1);
        matcher.push(Buffer.from("tail"), 8);
        matcher.dispose();
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(found.length, 1);
    });

    test("matching is case-sensitive, as the pattern is written", () => {
        const { matcher, found } = collect([], ["ERROR"]);
        matcher.push(Buffer.from("error\nERROR\n"), 0);
        assert.equal(found.length, 1);
        matcher.dispose();
    });
});

describe("line endings", () => {
    test("a carriage return becomes a line feed, and \\r\\n is one line break, also across chunks", () => {
        const endings = new LineEndings();
        const out = [
            endings.push(Buffer.from("a\r\nb\rc")),
            endings.push(Buffer.from("\r")),
            endings.push(Buffer.from("\nd\n")),
        ]
            .map((buffer) => buffer.toString())
            .join("");
        assert.equal(out, "a\nb\nc\nd\n");
    });
});
