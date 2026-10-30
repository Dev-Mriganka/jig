import type { TokenNode } from "react-diff-view";
import { refractor } from "refractor/core";
import css from "refractor/css";
import json from "refractor/json";
import markdown from "refractor/markdown";
import markup from "refractor/markup";
import tsx from "refractor/tsx";
import yaml from "refractor/yaml";

const registeredLanguages = [css, json, markdown, markup, tsx, yaml];

for (const language of registeredLanguages) {
  refractor.register(language);
}

/** Compatibility wrapper for react-diff-view's older refractor token contract. */
export const syntaxHighlighter = {
  highlight: (code: string, language: string): TokenNode[] =>
    refractor.highlight(code, language).children,
};
