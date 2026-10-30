// The collections as configured, read, and the ways a call finds what it names: a request, a folder, an environment. Every
// lookup that finds nothing, or too much, is invalid input that says what there is, because the agent has no other way to
// learn the names.
import type { ApiSettings } from "./config.ts";
import { InputError, shortList, shown } from "./engine/values.ts";
import { pathOf } from "./model.ts";
import type { Collection, Environment, SavedRequest } from "./model.ts";

export interface Catalog {
    /** One configured collection, read now. Collections are read when something asks for them, and once per catalog. */
    collection(name: string): Collection;
    /** The collections a call may mean: the named one, or all. */
    selected(name: string | undefined): readonly Collection[];
    /** The one request a call names. */
    request(name: unknown, collection: string | undefined, folder: string | undefined): SavedRequest;
    /** The requests of a folder, and the collection that holds it. */
    folder(folder: unknown, collection: string | undefined): { collection: Collection; folder: string; requests: SavedRequest[] };
    /** The environment of a collection. */
    environment(collection: Collection, label: unknown): Environment;
}

/** `Orders/Smoke`: a folder's path, as a call writes it. */
const folderPath = (request: SavedRequest): string => request.folder.join("/");

function inFolder(request: SavedRequest, folder: string): boolean {
    const path = folderPath(request);
    return path === folder || path.startsWith(`${folder}/`);
}

const trimmed = (value: string): string => value.replace(/^\/+|\/+$/g, "");

export function loadCatalog(settings: ApiSettings): Catalog {
    const read = new Map<string, Collection>();
    const known = (): string => shortList([...settings.collections.keys()], ", ", 80);

    const catalog: Catalog = {
        collection(name) {
            const configured = settings.collections.get(name);
            if (configured === undefined) throw new InputError(`no collection named ${shown(name, 30)}. Known collections: ${known()}`);
            let collection = read.get(name);
            if (collection === undefined) {
                collection = configured.load();
                read.set(name, collection);
            }
            return collection;
        },

        selected: (name) =>
            (name === undefined ? [...settings.collections.keys()].map((each) => catalog.collection(each)) : [catalog.collection(name)]),

        request(name, collection, folder) {
            if (typeof name !== "string" || name.trim() === "") throw new InputError("api needs request, the name of a saved request");
            const wanted = folder === undefined ? undefined : trimmed(folder);
            const found = catalog.selected(collection).flatMap((candidate) =>
                candidate.requests.filter((request) =>
                    (request.name === name || pathOf(request) === name) && (wanted === undefined || inFolder(request, wanted))),
            );
            if (found.length === 1) return found[0] as SavedRequest;
            if (found.length > 1) {
                const where = found.map((request) => `${request.collection}:${pathOf(request)}`);
                throw new InputError(`${shown(name, 40)} names ${found.length} requests (${shortList(where, ", ", 90)}): add collection or folder`);
            }
            const lower = name.toLowerCase();
            const near = catalog.selected(collection).flatMap((candidate) =>
                candidate.requests.filter((request) => request.name.toLowerCase().includes(lower)));
            const hint = near.length === 0 ? "use list to see them" : `similar: ${shortList(near.map((request) => request.name), ", ", 70)}`;
            throw new InputError(`no request named ${shown(name, 40)}; ${hint}`);
        },

        folder(folder, collection) {
            if (typeof folder !== "string" || trimmed(folder) === "") throw new InputError("api needs folder, such as Orders or Orders/Smoke");
            const wanted = trimmed(folder);
            const matches = catalog.selected(collection)
                .map((candidate) => ({ collection: candidate, requests: candidate.requests.filter((request) => inFolder(request, wanted)) }))
                .filter((match) => match.requests.length > 0);
            if (matches.length === 1) return { ...(matches[0] as { collection: Collection; requests: SavedRequest[] }), folder: wanted };
            if (matches.length > 1) {
                const names = matches.map((match) => match.collection.name).join(" and ");
                throw new InputError(`${shown(wanted, 40)} is a folder of ${names}: add collection`);
            }
            const paths = catalog.selected(collection).flatMap((candidate) => candidate.requests.map(folderPath));
            const folders = [...new Set(paths)].filter((path) => path !== "");
            throw new InputError(`no folder named ${shown(wanted, 40)}${folders.length === 0 ? "" : `; folders: ${shortList(folders, ", ", 80)}`}`);
        },

        environment(collection, label) {
            const found = typeof label === "string" ? collection.environments.get(label) : undefined;
            if (found !== undefined) return found;
            const names = [...collection.environments.keys()];
            const have = names.length === 0 ? `${collection.name} has no environments` : `${collection.name} has: ${shortList(names, ", ", 70)}`;
            throw new InputError(`no environment named ${shown(label, 30)}; ${have}`);
        },
    };
    return catalog;
}
