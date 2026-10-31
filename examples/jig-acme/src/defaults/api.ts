// Defaults for `api`. A real company puts here where its saved API requests live and how its environment names map to Jig's.
//
// `collections` names sources of saved requests: a Postman export, a Bruno or `.http` folder, an OpenAPI file. Acme keeps a folder of
// `.http` files in a repository that everyone clones to `~/work/acme-api` (a path is absolute or starts with `~/`).
//
// `environments` maps the environment names inside the collections (`Dev`, `Staging`, `Prod`) to Jig's (environments.ts). A name left
// out counts as production. An entry may name how requests get in: Acme's staging API is reachable only through the corporate
// gateway, so its entry names the `acme-gateway` transport (transport.ts). A user's own entry replaces the company's whole, so it
// never names both a sign-in service and a transport.
export const apiDefaults = {
    collections: { acme: { http: "~/work/acme-api/http" } },
    environments: {
        Dev: "dev",
        Staging: { environment: "staging", transport: "acme-gateway" },
        Prod: "prod",
    },
};
