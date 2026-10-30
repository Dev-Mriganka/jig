import type { FC, ReactNode, WheelEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import type { FileReviewMetrics } from "./reviewMetrics.js";

type FileExplorerProps = {
  files: FileReviewMetrics[];
};

type TreeNode = {
  children: Map<string, TreeNode>;
  file?: FileReviewMetrics;
  name: string;
  path: string;
};

/**
 * Renders sticky file navigation that scrolls to each changed file.
 */
export const FileExplorer: FC<FileExplorerProps> = ({ files }) => {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [activeAnchorId, setActiveAnchorId] = useState<string>();
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());

  useActiveFileObserver(files, setActiveAnchorId);

  const toggle = (path: string): void => {
    setCollapsedPaths((current) => {
      const next = new Set(current);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  };

  return (
    <aside
      className="sticky top-24 max-h-[calc(100vh-7rem)] space-y-3 overflow-y-auto overscroll-contain rounded-lg bg-white p-4 shadow"
      onWheel={(event: WheelEvent<HTMLElement>) => {
        event.stopPropagation();
      }}
    >
      <h2 className="font-semibold">Files</h2>
      <nav className="space-y-1 text-sm">
        {[...tree.children.values()].map((node) =>
          renderTreeNode(node, collapsedPaths, toggle, activeAnchorId, 0),
        )}
      </nav>
    </aside>
  );
};

function renderTreeNode(
  node: TreeNode,
  collapsedPaths: Set<string>,
  toggle: (path: string) => void,
  activeAnchorId: string | undefined,
  depth: number,
): ReactNode {
  if (node.file !== undefined) {
    return renderFileNode(node.file, activeAnchorId, depth);
  }

  const isCollapsed = collapsedPaths.has(node.path);

  return (
    <div
      className={depth === 0 ? "border-t border-slate-200 pt-1 first:border-t-0 first:pt-0" : ""}
      key={node.path}
    >
      <button
        className="flex w-full items-center gap-1 rounded bg-slate-50 px-2 py-1 text-left hover:bg-slate-100"
        onClick={() => {
          toggle(node.path);
        }}
        style={{ paddingLeft: `${(depth * 0.75 + 0.5).toString()}rem` }}
        type="button"
      >
        <span className="text-xs text-slate-500">{isCollapsed ? "▸" : "▾"}</span>
        <span className="truncate font-medium text-slate-700" title={node.path}>
          {node.name}
        </span>
      </button>
      {isCollapsed ? undefined : (
        <div>
          {[...node.children.values()].map((child) =>
            renderTreeNode(child, collapsedPaths, toggle, activeAnchorId, depth + 1),
          )}
        </div>
      )}
    </div>
  );
}

function renderFileNode(
  file: FileReviewMetrics,
  activeAnchorId: string | undefined,
  depth: number,
): ReactNode {
  return (
    <a
      className={getFileNodeClassName(file, activeAnchorId === file.anchorId)}
      href={`#${file.anchorId}`}
      key={file.filePath}
      style={{ paddingLeft: `${(depth * 0.75 + 0.5).toString()}rem` }}
    >
      <div className="truncate font-mono text-xs text-slate-700" title={file.filePath}>
        {file.filePath.split("/").at(-1) ?? file.filePath}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-xs">
        <span className="text-emerald-700">+{file.stats.added}</span>
        <span className="text-red-700">-{file.stats.deleted}</span>
        <span className="text-slate-500">· {file.messages}</span>
        {file.changedSinceLastReview ? (
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
            changed
          </span>
        ) : undefined}
      </div>
    </a>
  );
}

function getFileNodeClassName(file: FileReviewMetrics, isActive: boolean): string {
  const baseClassName = "block rounded border px-2 py-1 hover:border-blue-300 hover:bg-blue-50";

  if (isActive) {
    return `${baseClassName} border-blue-400 bg-blue-50 ring-1 ring-blue-200`;
  }

  if (file.changedSinceLastReview) {
    return `${baseClassName} border-amber-300 bg-amber-50`;
  }

  return `${baseClassName} border-transparent`;
}

function useActiveFileObserver(
  files: FileReviewMetrics[],
  setActiveAnchorId: (anchorId: string | undefined) => void,
): void {
  useEffect(() => {
    const visibleFiles = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleFiles.add(entry.target.id);
          } else {
            visibleFiles.delete(entry.target.id);
          }
        }

        setActiveAnchorId(getFirstVisibleFileId(files, visibleFiles));
      },
      { rootMargin: "-96px 0px -65% 0px", threshold: 0 },
    );

    for (const file of files) {
      const element = document.getElementById(file.anchorId);

      if (element !== null) {
        observer.observe(element);
      }
    }

    return (): void => {
      observer.disconnect();
    };
  }, [files, setActiveAnchorId]);
}

function getFirstVisibleFileId(
  files: FileReviewMetrics[],
  visibleFiles: Set<string>,
): string | undefined {
  return files.find((file) => visibleFiles.has(file.anchorId))?.anchorId;
}

function buildFileTree(files: FileReviewMetrics[]): TreeNode {
  const root: TreeNode = { children: new Map(), name: "", path: "" };

  for (const file of files) {
    addFileToTree(root, file);
  }

  sortTree(root);

  return root;
}

function addFileToTree(root: TreeNode, file: FileReviewMetrics): void {
  const segments = file.filePath.split("/");
  let current = root;

  for (const [index, segment] of segments.entries()) {
    const path = current.path.length === 0 ? segment : `${current.path}/${segment}`;
    const isFile = index === segments.length - 1;
    const next: TreeNode = current.children.get(segment) ?? {
      children: new Map(),
      name: segment,
      path,
    };

    if (isFile) {
      next.file = file;
    }

    current.children.set(segment, next);
    current = next;
  }
}

function sortTree(node: TreeNode): void {
  node.children = new Map(
    [...node.children.entries()].sort(([, left], [, right]) => {
      if ((left.file === undefined) !== (right.file === undefined)) {
        return left.file === undefined ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    }),
  );

  for (const child of node.children.values()) {
    sortTree(child);
  }
}
