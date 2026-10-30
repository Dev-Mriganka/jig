import { getReviewFilePath, type ReviewFile } from "@web/review-file.js";
import { syntaxHighlighter } from "@web/syntaxHighlighter.js";
import type { HunkTokens } from "react-diff-view";
import { markEdits, tokenize } from "react-diff-view";

export function getTokens(file: ReviewFile): HunkTokens {
  const language = getLanguage(getReviewFilePath(file));

  if (language === undefined) {
    return tokenize(file.hunks, {
      enhancers: [markEdits(file.hunks)],
      highlight: false,
    });
  }

  return tokenize(file.hunks, {
    enhancers: [markEdits(file.hunks)],
    highlight: true,
    language,
    refractor: syntaxHighlighter,
  });
}

export function isCollapsedByDefault(filePath: string): boolean {
  const segments = filePath.split("/");
  const fileName = segments.at(-1) ?? filePath;

  return (
    segments.some((segment) => segment.startsWith(".")) ||
    fileName.endsWith(".lock") ||
    [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "tsconfig.tsbuildinfo",
      "yarn.lock",
    ].includes(fileName) ||
    /(^|\.)config\.[cm]?[jt]s$/.test(fileName) ||
    /^(eslint|postcss|prettier|tailwind|vite)\.config\.[cm]?[jt]s$/.test(fileName)
  );
}

function getLanguage(filePath: string): string | undefined {
  const extension = filePath.split(".").pop();

  switch (extension) {
    case "cjs":
    case "js":
    case "jsx":
    case "mjs":
      return "javascript";
    case "css":
      return "css";
    case "html":
      return "markup";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "ts":
    case "tsx":
      return "typescript";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return undefined;
  }
}
