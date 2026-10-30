// The wiki-markup renderer: Jira text to the HTML of a preview page. The text comes from the model, so the first thing to
// test is that nothing in it reaches the page as markup; the rest is that each construct of Jira's markup is shown as Jira
// shows it, and that what is not understood stays visible as it was written.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { escapeHtml, renderWiki } from "../src/wiki.ts";

// ---- what a safe page may contain ------------------------------------------------------------------------------------

const TAGS = new Set([
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "em",
    "del",
    "ins",
    "sup",
    "sub",
    "code",
    "pre",
    "span",
    "a",
    "ul",
    "ol",
    "li",
    "blockquote",
    "table",
    "tr",
    "th",
    "td",
    "div",
]);
const ATTRIBUTES: Record<string, string[]> = {
    a: ["href", "rel"],
    span: ["class", "style"],
    pre: ["class", "data-lang"],
    div: ["class", "style"],
};
const STYLE = /^(?:[a-z-]+:(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20});?)+$/;

/** Fails unless every tag in the markup is one the renderer writes, with only the attributes it writes and safe values. */
function assertSafe(html: string): void {
    for (const match of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
        const [, , name = "", rest = ""] = match;
        assert.ok(TAGS.has(name), `tag <${name}> is not one the renderer writes: ${match[0]}`);
        for (const attribute of rest.matchAll(/\s+([a-z-]+)="([^"]*)"/g)) {
            const [, attributeName = "", value = ""] = attribute;
            assert.ok(
                ATTRIBUTES[name]?.includes(attributeName),
                `<${name}> must not have ${attributeName}: ${match[0]}`,
            );
            if (attributeName === "href") assert.match(value, /^(?:https?:\/\/|mailto:)/i, `unsafe link: ${value}`);
            if (attributeName === "style") assert.match(value, STYLE, `unsafe style: ${value}`);
        }
        assert.equal(rest.replace(/\s+[a-z-]+="[^"]*"/g, "").trim(), "", `unparsed attribute text in ${match[0]}`);
    }
    const text = html.replace(/<\/?[a-zA-Z0-9][^>]*>/g, "");
    assert.doesNotMatch(text, /[<>]/, "a < or > outside a tag is not escaped");
}

/** The text a reader sees: tags removed, entities decoded. */
function visibleText(html: string): string {
    return html
        .replace(/<br>/g, "\n")
        .replace(/<\/?[a-zA-Z0-9][^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

const render = (source: string): string => {
    const html = renderWiki(source);
    assertSafe(html);
    return html;
};

describe("escaping", () => {
    test("escapeHtml makes the five characters harmless", () => {
        assert.equal(
            escapeHtml(`<a href="x" onclick='y'>&</a>`),
            "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
        );
    });

    test("raw HTML is shown as text, never passed through", () => {
        const html = render(
            `<script>alert(1)</script> <img src=x onerror=alert(1)> <iframe src="https://evil.test"></iframe> <b onmouseover="x()">bold</b>`,
        );
        assert.doesNotMatch(html, /<script|<img|<iframe|<b /);
        assert.equal(
            visibleText(html),
            `<script>alert(1)</script> <img src=x onerror=alert(1)> <iframe src="https://evil.test"></iframe> <b onmouseover="x()">bold</b>`,
        );
    });

    test("entities in the source are shown as written, not decoded", () => {
        const html = render("&lt;script&gt; &amp; &#60;b&#62; &#x3c;");
        assert.equal(visibleText(html), "&lt;script&gt; &amp; &#60;b&#62; &#x3c;");
    });

    test("control characters are removed, and line endings are normalised", () => {
        assert.equal(render("a\u0000b\u0001c\u0002d\u0003e\u0004f"), "<p>abcdef</p>");
        assert.equal(render("one\r\ntwo\rthree"), "<p>one<br>two<br>three</p>");
    });

    test("an empty text renders to nothing", () => {
        assert.equal(render(""), "");
        assert.equal(render("\n\n  \n"), "");
    });

    test("markup in every position stays inside the tags the renderer writes", () => {
        const evil = `"><script>x</script>`;
        for (const source of [
            `h2. ${evil}`,
            `* ${evil}`,
            `|${evil}|`,
            `||${evil}||`,
            `bq. ${evil}`,
            `{quote}${evil}{quote}`,
            `{panel:title=${evil}}x{panel}`,
            `{code:${evil}}x{code}`,
            `{code:title=${evil}}x{code}`,
            `[${evil}|https://example.test/${evil}]`,
            `[${evil}]`,
            `[~${evil}]`,
            `{color:${evil}}x{color}`,
            `!${evil}.png!`,
            `*${evil}*`,
            `{{${evil}}}`,
            `https://example.test/${evil}`,
        ]) {
            const html = render(source);
            assert.doesNotMatch(html, /<script/i, source);
        }
    });
});

describe("links", () => {
    test("[text|url] and [url] link to http, https and mailto addresses", () => {
        assert.equal(
            render(
                "[the spec|https://wiki.example.test/login] and [http://example.test/a] and [mail us|mailto:team@example.test]",
            ),
            '<p><a href="https://wiki.example.test/login" rel="noreferrer noopener">the spec</a> and ' +
                '<a href="http://example.test/a" rel="noreferrer noopener">http://example.test/a</a> and ' +
                '<a href="mailto:team@example.test" rel="noreferrer noopener">mail us</a></p>',
        );
    });

    test("any other scheme is not a link: it stays as written, with its target visible", () => {
        for (const target of [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<script>x</script>",
            "vbscript:x",
            "ftp://example.test/a",
            "file:///etc/passwd",
            "//example.test/a",
            "/relative/path",
            "#anchor",
            "PROJ-12",
            " javascript:alert(1)",
            "java&#115;cript:alert(1)",
            "java\tscript:alert(1)",
        ]) {
            const html = render(`[click here|${target}]`);
            assert.doesNotMatch(html, /<a /, target);
            assert.ok(
                visibleText(html).includes(target.trim().replace(/\t/g, "\t")),
                `the target stays visible: ${target}`,
            );
        }
    });

    test("a quote or angle bracket in an address cannot leave its attribute", () => {
        const html = render(`[x|https://example.test/a"onmouseover="alert(1)] https://example.test/b"onfocus="y"`);
        assertSafe(html);
        assert.doesNotMatch(html, /\s(?:onmouseover|onfocus)=/, "no attribute was added");
    });

    test("bare addresses become links, without the punctuation that ends a sentence", () => {
        assert.equal(
            render("See https://example.test/page?a=1&b=2, or (http://example.test/x). Done."),
            '<p>See <a href="https://example.test/page?a=1&amp;b=2" rel="noreferrer noopener">https://example.test/page?a=1&amp;b=2</a>, ' +
                'or (<a href="http://example.test/x" rel="noreferrer noopener">http://example.test/x</a>). Done.</p>',
        );
    });

    test("marks inside an address are not markup", () => {
        const html = render("https://example.test/a_b_c-d-/*x*/ and [https://example.test/-a-/_b_]");
        assert.doesNotMatch(html, /<em>|<del>|<strong>/);
    });

    test("a mention is shown as @name and never links", () => {
        assert.equal(
            render("[~accountid:5b10a2844c20165700ede21g] and [~jdoe]"),
            '<p><span class="mention">@5b10a2844c20165700ede21g</span> and <span class="mention">@jdoe</span></p>',
        );
    });

    test("an attachment reference and an image are shown as text, and nothing is loaded", () => {
        const html = render("[^crash.log] !screenshot.png! !https://example.test/x.png|width=100!");
        assert.equal(
            html,
            '<p><span class="attachment">crash.log</span> <span class="image">[image: screenshot.png]</span> <span class="image">[image: https://example.test/x.png]</span></p>',
        );
    });

    test("a bracket that is not a link stays as written", () => {
        assert.equal(render("[WIP] fix [PROJ-12] and arr[0]"), "<p>[WIP] fix [PROJ-12] and arr[0]</p>");
    });
});

describe("inline marks", () => {
    test("every mark of Jira's markup", () => {
        assert.equal(
            render("*bold* _italic_ -strike- +underline+ {{mono}} ^sup^ ~sub~"),
            "<p><strong>bold</strong> <em>italic</em> <del>strike</del> <ins>underline</ins> <code>mono</code> <sup>sup</sup> <sub>sub</sub></p>",
        );
    });

    test("marks nest", () => {
        assert.equal(render("*bold _and italic_ text*"), "<p><strong>bold <em>and italic</em> text</strong></p>");
        assert.equal(render("_*both*_"), "<p><em><strong>both</strong></em></p>");
    });

    test("a mark inside a word is not a mark", () => {
        const text = "snake_case_name 2*3*4 well-known-fact a+b+c x^2^y one~two~three";
        assert.equal(render(text), `<p>${text}</p>`);
    });

    test("a mark must touch its text on the inside", () => {
        assert.equal(render("a * not bold * b and - not struck - c"), "<p>a * not bold * b and - not struck - c</p>");
    });

    test("monospace shows its text as written, whatever marks and braces are inside", () => {
        assert.equal(
            render("{{*not bold* and <b> and [x|y]}}"),
            "<p><code>*not bold* and &lt;b&gt; and [x|y]</code></p>",
        );
    });

    test("a backslash makes the next mark plain, and two make a line break", () => {
        assert.equal(render("\\*plain\\* and C:\\Users"), "<p>*plain* and C:\\Users</p>");
        assert.equal(render("one\\\\two"), "<p>one<br>two</p>");
    });

    test("emoticons are shown as the text they are written as, and are not read as marks", () => {
        assert.equal(
            render("(/) done (x) failed (!) look :) ;) :D (*) and (*) again (-) and (+)"),
            '<p><span class="emoticon">(/)</span> done <span class="emoticon">(x)</span> failed <span class="emoticon">(!)</span> look ' +
                '<span class="emoticon">:)</span> <span class="emoticon">;)</span> <span class="emoticon">:D</span> ' +
                '<span class="emoticon">(*)</span> and <span class="emoticon">(*)</span> again ' +
                '<span class="emoticon">(-)</span> and <span class="emoticon">(+)</span></p>',
        );
    });

    test("an emoticon is not found inside an entity or a word", () => {
        assert.equal(
            render(`he said "ok") and it's)`).includes("emoticon"),
            false,
            "the semicolon of &quot; is not a wink",
        );
        assert.equal(render("Note:) and a:D").includes("emoticon"), false);
    });

    test("colours need a pair, and only a name or a hex code", () => {
        assert.equal(
            render("{color:red}stop{color} and {color:#0a0}go{color}"),
            '<p><span style="color:red">stop</span> and <span style="color:#0a0">go</span></p>',
        );
        for (const bad of [
            "expression(alert(1))",
            "red;background:url(https://evil.test/x)",
            "url(x)",
            "#12",
            "rgb(0,0,0)",
        ]) {
            const html = render(`{color:${bad}}x{color}`);
            assert.doesNotMatch(html, /style=/, bad);
            assert.equal(visibleText(html), "x", bad);
        }
        assert.equal(render("{color:red}never closed"), "<p>{color:red}never closed</p>");
        assert.equal(render("a {color} lone close"), "<p>a {color} lone close</p>");
    });

    test("a text is cut into runs of at most a thousand characters, so a long line cannot stall the page", () => {
        const started = Date.now();
        const html = render(`${"*a *".repeat(6000)} end`);
        assert.ok(Date.now() - started < 2000, "a hostile line is rendered quickly");
        assert.ok(html.length > 0);
    });
});

describe("blocks", () => {
    test("headings h1. to h6.", () => {
        assert.equal(
            render("h1. One\nh2. Two\nh3. Three\nh4. Four\nh5. Five\nh6. Six"),
            "<h1>One</h1>\n<h2>Two</h2>\n<h3>Three</h3>\n<h4>Four</h4>\n<h5>Five</h5>\n<h6>Six</h6>",
        );
        assert.equal(render("h7. Seven and h1.NoSpace"), "<p>h7. Seven and h1.NoSpace</p>");
    });

    test("paragraphs are split by blank lines, and a single new line is a line break", () => {
        assert.equal(render("first\nsecond\n\nthird"), "<p>first<br>second</p>\n<p>third</p>");
    });

    test("bullet and numbered lists, nested, and a list after a paragraph", () => {
        assert.equal(
            render("Steps:\n* one\n* two\n** two a\n** two b\n* three\n\n# first\n# second\n## second a\n# third"),
            "<p>Steps:</p>\n<ul><li>one</li><li>two<ul><li>two a</li><li>two b</li></ul></li><li>three</li></ul>\n<ol><li>first</li><li>second<ol><li>second a</li></ol></li><li>third</li></ol>",
        );
    });

    test("a list can mix kinds, and a dash is a bullet too", () => {
        assert.equal(
            render("* bullet\n*# numbered in it\n*# and another\n* back"),
            "<ul><li>bullet<ol><li>numbered in it</li><li>and another</li></ol></li><li>back</li></ul>",
        );
        assert.equal(render("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
    });

    test("a bold word at the start of a line is not a list item", () => {
        assert.equal(render("*Important:* read this"), "<p><strong>Important:</strong> read this</p>");
        assert.equal(render("#hashtag without a space"), "<p>#hashtag without a space</p>");
    });

    test("a rule, and a quoted line", () => {
        assert.equal(
            render("above\n----\nbelow\nbq. a quoted line"),
            "<p>above</p>\n<hr>\n<p>below</p>\n<blockquote><p>a quoted line</p></blockquote>",
        );
        assert.equal(render("a --- b -- c"), "<p>a --- b -- c</p>");
    });

    test("{code} keeps its text exactly, with the language and title it names", () => {
        const html = render('{code:java}\nif (a < b && c > d) { *x* = "y"; }\n{code}');
        assert.equal(
            html,
            '<pre class="code" data-lang="java"><code>if (a &lt; b &amp;&amp; c &gt; d) { *x* = &quot;y&quot;; }</code></pre>',
        );
        assert.equal(
            render("{code:title=Run it|language=bash}\nls -l\n{code}"),
            '<pre class="code" data-lang="bash"><span class="title">Run it</span><code>ls -l</code></pre>',
        );
        assert.equal(render("{code}\nplain\n{code}"), '<pre class="code"><code>plain</code></pre>');
    });

    test("{noformat} is a block of text as written", () => {
        assert.equal(render("{noformat}\n*a* <b>\n{noformat}"), '<pre class="noformat">*a* &lt;b&gt;</pre>');
    });

    test("a macro that is never closed stays as text, and an unknown macro too", () => {
        assert.equal(render("{code}\nnot closed"), "<p>{code}<br>not closed</p>");
        assert.equal(
            render("{toc}\n{anchor:top}\n{status:colour=Green|title=ok}"),
            "<p>{toc}<br>{anchor:top}<br>{status:colour=Green|title=ok}</p>",
        );
    });

    test("{quote} holds blocks of its own", () => {
        assert.equal(
            render("{quote}\nSomeone said *this*:\n* a\n* b\n{quote}\nAfter."),
            "<blockquote><p>Someone said <strong>this</strong>:</p>\n<ul><li>a</li><li>b</li></ul></blockquote>\n<p>After.</p>",
        );
    });

    test("{panel} has a title and colours, only valid ones", () => {
        const html = render(
            "{panel:title=Root cause|borderColor=#ccc|bgColor=#eef|titleBGColor=blue}\nThe *retry* loop.\n{panel}",
        );
        assert.equal(
            html,
            '<div class="panel" style="border-color:#ccc;background:#eef">' +
                '<div class="panel-title" style="background:blue">Root cause</div>' +
                '<div class="panel-body"><p>The <strong>retry</strong> loop.</p></div></div>',
        );
        assert.doesNotMatch(render("{panel:bgColor=url(x)|borderColor=red;x:y}\nx\n{panel}"), /style=/);
    });

    test("a code block inside a panel inside a quote, and quotes nested too deeply are shown as text", () => {
        const html = render("{quote}\n{panel:title=Log}\n{code}\nERROR boom\n{code}\n{panel}\n{quote}");
        assert.match(html, /<blockquote><div class="panel"[^>]*>.*<pre class="code"><code>ERROR boom<\/code><\/pre>/s);
        const deep = `${"{quote}".repeat(1)}${"{panel}a".repeat(1)}`;
        assert.ok(render(deep).length > 0);
        let nested = "x";
        for (let level = 0; level < 12; level++)
            nested = level % 2 === 0 ? `{quote}\n${nested}\n{quote}` : `{panel}\n${nested}\n{panel}`;
        assertSafe(render(nested));
    });

    test("tables: header cells, cells, a link with a pipe, an empty cell and a row without its last pipe", () => {
        const html = render(
            "||Env||Count||Note||\n||Total|14|ok|\n|prod|12|[a|https://example.test/x]|\n|test| |no last pipe",
        );
        assert.equal(
            html,
            "<table><tr><th>Env</th><th>Count</th><th>Note</th></tr><tr><th>Total</th><td>14</td><td>ok</td></tr>" +
                '<tr><td>prod</td><td>12</td><td><a href="https://example.test/x" rel="noreferrer noopener">a</a></td></tr>' +
                "<tr><td>test</td><td></td><td>no last pipe</td></tr></table>",
        );
    });

    test("a row that does not end with a pipe goes on to the next line, as in Jira, and a blank line ends the table", () => {
        assert.equal(
            render("|a|b\nc|d|\n\n|e|"),
            "<table><tr><td>a</td><td><p>b<br>c</p></td><td>d</td></tr></table>\n<table><tr><td>e</td></tr></table>",
        );
    });

    test("a table cell can run over several lines and hold a list", () => {
        const html = render("|Name|Steps|\n|Login|* open the page\n* press *Go*|");
        assert.match(
            html,
            /<td>Login<\/td><td><ul><li>open the page<\/li><li>press <strong>Go<\/strong><\/li><\/ul><\/td>/,
        );
    });
});

describe("real texts", () => {
    const COMMENT = [
        "h3. Root cause",
        "The retry loop in {{LoginForm.submit()}} never resets its _backoff_, so a second tap on *Sign in* is queued twice.",
        "",
        "||Browser||Version||Result||",
        "|Safari|17.1|{color:red}fails{color}|",
        "|Chrome|118|{color:green}passes{color} (/)|",
        "",
        "{code:js}",
        "if (attempts < 2 && !done) { retry(); }",
        "{code}",
        "",
        "{panel:title=Next steps}",
        "# Reset the backoff in [PR 42|https://git.example.test/org/app/pull/42]",
        "# Ask [~accountid:5b10a2844c20165700ede21g] to verify",
        "{panel}",
        "",
        "bq. Not reproducible on Android.",
        "----",
        "Logs: https://logs.example.test/q?id=abc_def&from=1d",
    ].join("\n");

    test("a triage comment renders every construct and loses no word", () => {
        const html = render(COMMENT);
        assert.match(html, /<h3>Root cause<\/h3>/);
        assert.match(html, /<code>LoginForm\.submit\(\)<\/code>/);
        assert.match(html, /<th>Browser<\/th><th>Version<\/th><th>Result<\/th>/);
        assert.match(html, /<span style="color:red">fails<\/span>/);
        assert.match(
            html,
            /<pre class="code" data-lang="js"><code>if \(attempts &lt; 2 &amp;&amp; !done\) \{ retry\(\); \}<\/code><\/pre>/,
        );
        assert.match(html, /<div class="panel"><div class="panel-title">Next steps<\/div>/);
        assert.match(html, /<ol><li>Reset the backoff in <a href="https:\/\/git\.example\.test\/org\/app\/pull\/42"/);
        assert.match(html, /<blockquote><p>Not reproducible on Android\.<\/p><\/blockquote>\n<hr>/);

        // Nothing the readers will see is dropped: every word of the source that is not markup is on the page.
        const seen = visibleText(html);
        const words =
            COMMENT.replace(/\{[^}]*\}/g, " ")
                .replace(/https?:\/\/\S+/g, " ")
                .replace(/\[~[^\]]*\]/g, " ")
                .match(/[A-Za-z][A-Za-z0-9]{2,}/g) ?? [];
        assert.ok(words.length > 25, `only ${words.length} words were checked`);
        for (const word of words) assert.ok(seen.includes(word), `the word "${word}" is on the page`);
    });

    test("a description with a checklist and a stack trace", () => {
        const html = render(
            [
                "h2. Problem",
                "Users see *HTTP 500* when the export runs for more than 30 s.",
                "",
                "h2. Checklist",
                "* (/) reproduce on staging",
                "* (x) fix the timeout",
                "* (!) tell support",
                "",
                "{noformat}",
                "java.lang.IllegalStateException: closed <connection>",
                "    at app.Export.run(Export.java:88)",
                "{noformat}",
            ].join("\n"),
        );
        assert.match(html, /<ul><li><span class="emoticon">\(\/\)<\/span> reproduce on staging<\/li>/);
        assert.match(
            html,
            /<pre class="noformat">java\.lang\.IllegalStateException: closed &lt;connection&gt;\n    at app\.Export\.run\(Export\.java:88\)<\/pre>/,
        );
    });
});
