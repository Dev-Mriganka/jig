// Defaults for `mongo`. A real company puts here its database addresses per environment, how to reach them, and what the agent
// may see.
//
// `connections` is by Jig environment. `dev` is reachable directly. `staging` and `prod` are behind the bastion host, so their
// `via` names the `acme-bastion` tunnel (tunnel.ts), a forward to exactly one host: each address is one `mongodb://host:port`.
// A `uri` never holds a user or a password; they are given apart, and a password is a secret reference. Production uses a
// read-only user.
//
// `access` is a deny list in a test environment (everything is visible unless named) and an allow list in production (nothing is
// visible unless named, field by field). A small collection of reference data is marked `reference: true`: the production index
// check, which refuses a read that scans a whole collection, lets it be read whole.
export const mongoDefaults = {
    connections: {
        dev: {
            uri: "mongodb://mongo.dev.acme.example:27017",
            user: "agent",
            password: "pass:acme/mongo-dev",
        },
        staging: {
            uri: "mongodb://mongo.staging.acme.example:27017",
            user: "agent",
            password: "pass:acme/mongo-staging",
            via: { tunnel: "acme-bastion" },
        },
        prod: {
            uri: "mongodb://mongo.prod.acme.example:27017",
            user: "agent-readonly",
            password: "pass:acme/mongo-prod",
            via: { tunnel: "acme-bastion" },
        },
    },
    access: {
        dev: { deny: ["billing.cards"] },
        staging: { deny: ["billing.cards", "*.notes"] },
        prod: {
            allow: {
                "orders.orders": ["_id", "status", "items", "createdAt"],
                "orders.countries": { fields: ["_id", "code", "name"], reference: true },
            },
        },
    },
};
