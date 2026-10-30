import type { FC } from "react";

type ConversationDiffSnippetProps = {
  diff: string;
};

/**
 * Renders a compact unified-diff snippet inside an agent conversation message.
 */
export const ConversationDiffSnippet: FC<ConversationDiffSnippetProps> = ({ diff }) => (
  <div className="overflow-x-auto rounded border border-slate-200 bg-white font-mono text-xs">
    {diff.split("\n").map((line, index) => (
      <div className={getDiffLineClassName(line)} key={`${index.toString()}-${line}`}>
        <span className="inline-block w-5 select-none text-right text-slate-400">
          {getDiffLineMarker(line)}
        </span>
        <span className="whitespace-pre-wrap pl-2">{getDiffLineText(line)}</span>
      </div>
    ))}
  </div>
);

function getDiffLineClassName(line: string): string {
  const baseClassName = "flex min-w-max border-l-4 px-2 py-0.5";

  if (line.startsWith("+")) {
    return `${baseClassName} border-emerald-400 bg-emerald-50 text-emerald-950`;
  }

  if (line.startsWith("-")) {
    return `${baseClassName} border-red-400 bg-red-50 text-red-950`;
  }

  if (line.startsWith("@@")) {
    return `${baseClassName} border-blue-300 bg-blue-50 text-blue-900`;
  }

  return `${baseClassName} border-transparent text-slate-700`;
}

function getDiffLineMarker(line: string): string {
  if (line.startsWith("+") || line.startsWith("-")) {
    return line.charAt(0);
  }

  return "";
}

function getDiffLineText(line: string): string {
  if (line.startsWith("+") || line.startsWith("-")) {
    return line.slice(1);
  }

  return line;
}
