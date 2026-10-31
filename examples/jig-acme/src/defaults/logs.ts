// Defaults for `logs`. A real company puts here where its logs are, what kind of backend that is, how to sign in, and which
// slice of the logs each environment means.
//
// Acme's logs are an OpenSearch cluster, which the `elasticsearch` type also covers. One index pattern per environment, and a
// `filter` that keeps only the services of this catalog: a value that is a list matches a hit whose field is any of them.
// The cluster sits behind Acme's single sign-on, so requests sign in with the `acme-sso` service (signin.ts). A user off the
// corporate network writes `"backend": { "transport": "acme-gateway" }` in their own jig.json: that displaces `auth` here,
// because the plugin says the two exclude each other.
const services = { "service.keyword": ["orders-api", "billing-worker"] };

export const logsDefaults = {
    backend: {
        type: "elasticsearch",
        url: "https://logs.acme.example",
        auth: { signIn: "acme-sso" },
    },
    // The names are Jig environments (environments.ts): a name nobody defined would count as production.
    environments: {
        dev: { index: "acme-logs-dev-*", filter: services },
        staging: { index: "acme-logs-staging-*", filter: services },
        prod: { index: "acme-logs-prod-*", filter: services },
    },
};
