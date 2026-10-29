// A preview rendered as a web page, for reading in the browser (the `o` key on the review screen).
//
// The browser only shows. The page has no script and no form, nothing in it can answer the question, and there is no
// server: the page is a file under `<state>/previews/` that the browser opens directly. Approval stays in Pi.
//
// The text in a preview can come from the model (a pull request description it wrote), so it is treated as untrusted:
// raw HTML in it is shown as text, links are kept only for http, https and mailto, images are shown as their
// description, and the page tells the browser to load nothing from outside.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Marked } from "@earendil-works/pi-tui";
import type { Tokens } from "@earendil-works/pi-tui";
import type { Preview } from "./contract.ts";
import { errorMessage } from "./errors.ts";
import { resolveProgram } from "./exec.ts";
import { createPrivateFile, privateDir, removeOldFiles, stateDir } from "./paths.ts";

export function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const markdown = new Marked({
    renderer: {
        html: (token: Tokens.HTML | Tokens.Tag) => escapeHtml(token.text),
        image: (token: Tokens.Image) => escapeHtml(token.text),
        link(token: Tokens.Link) {
            const inner = this.parser.parseInline(token.tokens);
            if (!/^(?:https?:|mailto:)/i.test(token.href)) return inner;
            return `<a href="${escapeHtml(token.href)}" rel="noreferrer noopener">${inner}</a>`;
        },
    },
});

/** A diff with a colour for added and removed lines. */
function renderDiff(text: string): string {
    const lines = text.split("\n").map((line) => {
        const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
            ? "d-meta"
            : line.startsWith("@@") ? "d-hunk"
            : line.startsWith("+") ? "d-add"
            : line.startsWith("-") ? "d-del"
            : "d-ctx";
        return `<span class="${kind}">${escapeHtml(line)}</span>`;
    });
    return `<pre class="diff">${lines.join("\n")}</pre>`;
}

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --add: #dafbe1; --del: #ffebe9; --hunk: #ddf4ff; --code: #f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --line: #30363d; --add: #12261e; --del: #2d1517; --hunk: #0c2d6b; --code: #161b22; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 1.5rem 16px 4rem; }
.note { color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: .75rem; margin: 0 0 1rem; }
.meta { color: var(--muted); font-size: .875rem; margin: 0 0 .25rem; }
h1 { font-size: 1.25rem; margin: 0 0 1.25rem; }
pre, code { background: var(--code); border-radius: 6px; font: 14px/1.45 ui-monospace, monospace; }
pre { padding: .75rem 1rem; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
code { padding: .1rem .3rem; }
pre code { padding: 0; background: none; }
.diff span { display: block; }
.d-add { background: var(--add); } .d-del { background: var(--del); } .d-hunk { background: var(--hunk); } .d-meta { color: var(--muted); }
blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
table { border-collapse: collapse; } td, th { border: 1px solid var(--line); padding: .25rem .5rem; }
`;

/** The page for a preview. `header` is the line that names the tool, the action, the environment and the effect. */
export function renderPreviewPage(preview: Preview, header: string): string {
    let body = "";
    if (preview.body !== undefined) {
        if (preview.format === "markdown") body = markdown.parse(preview.body, { async: false });
        else if (preview.format === "diff") body = renderDiff(preview.body);
        else body = `<pre>${escapeHtml(preview.body)}</pre>`;
    }
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(preview.summary)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="note">This page only shows the preview. Approve or decline in Pi.</p>
<p class="meta">${escapeHtml(header)}</p>
<h1>${escapeHtml(preview.summary)}</h1>
${body}
</main>
</body>
</html>
`;
}

/** Writes the page under `<state>/previews/` (0600) and returns its path. */
export function writePreviewPage(preview: Preview, header: string): string {
    const dir = privateDir("previews");
    const file = join(dir, `${randomUUID()}.html`);
    createPrivateFile(file, renderPreviewPage(preview, header));
    return file;
}

/** Deletes preview pages older than `maxAgeDays`. */
export function cleanupPreviews(maxAgeDays: number, now: number = Date.now()): number {
    return removeOldFiles(join(stateDir(), "previews"), maxAgeDays, now);
}

/** The program and arguments that open `url`: `$BROWSER` when set (a program name, optionally followed by plain
 *  arguments, with `%s` standing for the address), else `open` on macOS and `xdg-open` elsewhere. */
export function browserCommand(url: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { program: string; args: string[] } {
    const chosen = env.BROWSER !== undefined && env.BROWSER.trim() !== "" ? env.BROWSER.trim().split(/\s+/) : [platform === "darwin" ? "open" : "xdg-open"];
    const [program, ...rest] = chosen as [string, ...string[]];
    const args = rest.some((arg) => arg.includes("%s")) ? rest.map((arg) => arg.replaceAll("%s", url)) : [...rest, url];
    return { program, args };
}

/** Starts a program and forgets it. Resolves once it has started, rejects when it cannot. */
export type Launch = (program: string, args: string[]) => Promise<void>;

const launchDetached: Launch = (program, args) =>
    new Promise((resolve, reject) => {
        const child = spawn(resolveProgram(program, undefined), args, { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });

/** Opens a page in the browser and says how it went, in a line the review screen can show. */
export async function openInBrowser(file: string, launch: Launch = launchDetached, env: NodeJS.ProcessEnv = process.env): Promise<string> {
    const { program, args } = browserCommand(pathToFileURL(file).href, env);
    try {
        await launch(program, args);
        return "opened in the browser";
    } catch (error) {
        return `could not open the browser: ${errorMessage(error)}`;
    }
}
