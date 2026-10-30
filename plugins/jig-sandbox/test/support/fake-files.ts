// A machine that exists only in memory: folders, files and links, for the rules to look at. Links are followed the way a
// file system follows them (parents of every component, absolute and relative targets, a limit on loops).
import path from "node:path";
import type { EntryType, FileView } from "../../src/files.ts";

export interface MachineSpec {
    /** Folders, made with their parents. */
    dirs?: string[];
    /** Files and their text (empty by default). */
    files?: Record<string, string>;
    /** Links: where the link is, and where it points as written. */
    links?: Record<string, string>;
}

type Node = { type: "directory" } | { type: "file"; text: string } | { type: "link"; target: string };

const MAX_LINKS = 40;

export interface FakeMachine extends FileView {
    /** Adds or replaces entries after the fact, as a command would. */
    put(spec: MachineSpec): void;
    remove(place: string): void;
}

export function fakeMachine(spec: MachineSpec = {}): FakeMachine {
    const nodes = new Map<string, Node>([["/", { type: "directory" }]]);

    const ensureDir = (folder: string): void => {
        for (let current = folder; current !== "/" && !nodes.has(current); current = path.posix.dirname(current)) {
            nodes.set(current, { type: "directory" });
        }
    };

    /** The entry at `place` without following the last component; the folders on the way are followed. */
    const lookup = (place: string): { at: string; node: Node | undefined } => {
        const parts = path.posix.resolve(place).split("/").filter(Boolean);
        let current = "/";
        let links = 0;
        for (let index = 0; index < parts.length; index++) {
            const next = path.posix.join(current, parts[index] as string);
            const node = nodes.get(next);
            const last = index === parts.length - 1;
            if (node === undefined) return { at: [next, ...parts.slice(index + 1)].join("/"), node: undefined };
            if (node.type === "link" && !last) {
                if (++links > MAX_LINKS) return { at: next, node: undefined };
                const target = path.posix.resolve(current, node.target);
                parts.splice(0, index + 1, ...target.split("/").filter(Boolean));
                current = "/";
                index = -1;
                continue;
            }
            if (last) return { at: next, node };
            current = next;
        }
        return { at: current, node: nodes.get(current) };
    };

    const follow = (place: string): { at: string; node: Node } | undefined => {
        let current = place;
        for (let links = 0; links <= MAX_LINKS; links++) {
            const { at, node } = lookup(current);
            if (node === undefined) return undefined;
            if (node.type !== "link") return { at, node };
            current = path.posix.resolve(path.posix.dirname(at), node.target);
        }
        return undefined;
    };

    const machine: FakeMachine = {
        put(more) {
            for (const folder of more.dirs ?? []) ensureDir(path.posix.resolve(folder));
            for (const [file, text] of Object.entries(more.files ?? {})) {
                ensureDir(path.posix.dirname(file));
                nodes.set(file, { type: "file", text });
            }
            for (const [link, target] of Object.entries(more.links ?? {})) {
                ensureDir(path.posix.dirname(link));
                nodes.set(link, { type: "link", target });
            }
        },
        remove(place) {
            for (const key of [...nodes.keys()]) if (key === place || key.startsWith(`${place}/`)) nodes.delete(key);
        },
        type(place): EntryType | undefined {
            const { node } = lookup(place);
            if (node === undefined) return undefined;
            return node.type === "link" ? "link" : node.type === "directory" ? "directory" : "file";
        },
        real: (place) => follow(place)?.at,
        list(place) {
            const found = follow(place);
            if (found === undefined || found.node.type !== "directory") return [];
            const prefix = found.at === "/" ? "/" : `${found.at}/`;
            const names = new Set<string>();
            for (const key of nodes.keys()) {
                if (key !== found.at && key.startsWith(prefix))
                    names.add(key.slice(prefix.length).split("/")[0] as string);
            }
            return [...names].sort();
        },
        read(place) {
            const found = follow(place);
            return found?.node.type === "file" ? found.node.text : undefined;
        },
        link(place) {
            const { node } = lookup(place);
            return node?.type === "link" ? node.target : undefined;
        },
    };
    machine.put(spec);
    return machine;
}
