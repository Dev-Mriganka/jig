// The `ops` section: what is accepted, what is refused and how each refusal reads, and how a call finds its service.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { catalogOf, describeServices, findEnvironment, healthProblem, readOps, validateOps } from "../src/catalog.ts";
import type { Catalog } from "../src/catalog.ts";
import { section, withDeploy, withEntry, withEnvironment } from "./support/section.ts";
import type { Raw } from "./support/section.ts";

function catalog(raw: unknown = section()): Catalog {
    const read = readOps(raw);
    assert.deepEqual(read.errors, []);
    assert.ok(read.catalog);
    return read.catalog;
}

/** A catalog with one service whose only environment is `entry`. */
const only = (entry: unknown): Raw => ({ services: { svc: { environments: { staging: entry } } } });
const KUBERNETES = { context: "c", namespace: "n", selector: "app=x" };

describe("a valid catalog", () => {
    test("has no errors and reads into services and environments", () => {
        assert.deepEqual(validateOps(section()), []);
        const read = catalog();
        assert.deepEqual([...read.services.keys()], ["orders-api", "billing"]);
        assert.deepEqual([...(read.services.get("orders-api")?.environments.keys() ?? [])], ["staging", "production"]);
        assert.equal(read.services.get("orders-api")?.repo, "acme/orders-api");
        assert.deepEqual(read.services.get("orders-api")?.ci, { system: "github-actions", workflow: "build.yml" });
    });

    test("reads an environment into its deploy method, its Kubernetes target and its health address", () => {
        const staging = catalog().services.get("orders-api")?.environments.get("staging");
        assert.deepEqual(staging?.deploy, { method: "helm", release: "orders-api", chart: "deploy/chart", set: [] });
        assert.equal(staging?.health, undefined);
        assert.deepEqual(staging?.kubernetes, {
            service: "orders-api",
            environment: "staging",
            context: "test-cluster",
            namespace: "orders-staging",
            selector: "app=orders-api",
            labels: [["app", "orders-api"]],
            container: "orders-api",
            port: 8080,
            healthPath: "/actuator/health",
        });
        const production = catalog().services.get("orders-api")?.environments.get("production");
        assert.equal(production?.deploy, undefined, "production has no deploy method on purpose");
        assert.equal(production?.health, "https://api.example.com/orders/health");
        assert.deepEqual(production?.kubernetes?.labels, [["app", "orders-api"], ["tier", "web"]]);
    });

    test("leaves container, port and health path out when the entry has none: they are needed only by the health check in a pod", () => {
        const target = catalog().services.get("billing")?.environments.get("staging")?.kubernetes;
        for (const key of ["container", "port", "healthPath"]) assert.equal(key in (target ?? {}), false, key);
    });

    test("an environment is known to jig-core by its own name: there is no mapping to another", () => {
        const staging = catalog().services.get("orders-api")?.environments.get("staging");
        assert.equal(staging?.name, "staging");
        assert.equal(staging?.service, "orders-api");
        assert.deepEqual(validateOps(section({ environments: { staging: "qa" } })), ["ops.environments: unknown field"]);
    });

    test("the example of the README is valid", () => {
        const example = {
            services: {
                "orders-api": {
                    repo: "acme/orders-api",
                    ci: { system: "github-actions", workflow: "build.yml" },
                    environments: {
                        staging: {
                            deploy: { method: "helm", release: "orders-api", chart: "deploy/chart" },
                            runtime: { kubernetes: { context: "staging", namespace: "orders", selector: "app=orders-api" } },
                            health: "https://api.staging.example.com/orders/health",
                        },
                        production: {
                            runtime: { kubernetes: { context: "prod", namespace: "orders", selector: "app=orders-api" } },
                        },
                    },
                },
            },
        };
        assert.deepEqual(validateOps(example), []);
    });

    test("a service needs no repo and no ci: without them the ci tool has nothing to look at", () => {
        const read = catalog({ services: { svc: { environments: { staging: { health: "https://svc.example.test/health" } } } } });
        assert.equal(read.services.get("svc")?.repo, undefined);
        assert.equal(read.services.get("svc")?.ci, undefined);
    });

    test("a ci entry is read with the fields of its system; ci-config.test.ts has them all", () => {
        const auth = { token: "env:CI_TOKEN" };
        for (const ci of [
            { system: "jenkins", url: "https://jenkins.example.test", job: "orders/build", auth: { user: "ci-bot", ...auth } },
            { system: "gitlab", url: "https://gitlab.example.test", project: "acme/orders-api", auth },
            { system: "github-actions" },
        ]) {
            const raw = section();
            const billing = (raw.services as Record<string, Raw>)["billing"] as Raw;
            billing.ci = ci;
            billing.repo = "acme/billing";
            assert.deepEqual(validateOps(raw), [], JSON.stringify(ci));
        }
    });

    test("a name such as constructor is only a name", () => {
        const raw = { services: { constructor: { environments: { staging: { health: "https://x.example.test/h" } } } } };
        const read = catalog(raw);
        assert.equal(read.services.get("constructor")?.environments.get("staging")?.service, "constructor");
        assert.equal(read.services.get("toString"), undefined);
        assert.throws(() => findEnvironment(read, "runtime", "toString", "staging"), TypeError);
        assert.throws(() => findEnvironment(read, "runtime", "constructor", "valueOf"), TypeError);
    });

    test("accepts the context names clouds use, and selectors with several pairs and prefixed labels", () => {
        for (const context of ["prod-cluster", "arn:aws:eks:eu-west-1:123456789012:cluster/prod", "user@cluster.example.test", "gke_proj_zone_name", "a"]) {
            assert.deepEqual(validateOps(withEntry("billing", "staging", { context })), [], context);
        }
        for (const selector of ["app=orders-api", "app=a,tier=web", "app.kubernetes.io/name=orders-api", "k8s-app=orders_api.v2"]) {
            assert.deepEqual(validateOps(withEntry("billing", "staging", { selector })), [], selector);
        }
    });
});

describe("a catalog that is refused", () => {
    test("must be an object with services", () => {
        assert.deepEqual(validateOps(undefined), ["ops: must be an object"]);
        assert.deepEqual(validateOps([]), ["ops: must be an object"]);
        assert.deepEqual(validateOps("services"), ["ops: must be an object"]);
        assert.deepEqual(validateOps({}), ["ops.services: required, an object that maps a service name to its entry"]);
        assert.deepEqual(validateOps({ services: [] }), ["ops.services: must be an object that maps a service name to its entry"]);
        assert.deepEqual(validateOps({ services: {} }), ["ops.services: must name 1 to 100 services"]);
    });

    test("an unknown field is an error that names its key, at every level", () => {
        assert.deepEqual(validateOps(section({ cluster: "x" })), ["ops.cluster: unknown field"]);
        const at = "ops.services.orders-api";
        const raw = section();
        const service = (raw.services as Record<string, Raw>)["orders-api"] as Raw;
        service.owner = "x";
        const staging = (service.environments as Record<string, Raw>).staging as Raw;
        staging.deploys = {};
        (staging.runtime as { kubernetes: Raw }).kubernetes.namespce = "x";
        (staging.deploy as Raw).chartt = "x";
        assert.deepEqual(validateOps(raw).sort(), [
            `${at}.environments.staging.deploy.chartt: unknown field`,
            `${at}.environments.staging.deploys: unknown field`,
            `${at}.environments.staging.runtime.kubernetes.namespce: unknown field`,
            `${at}.owner: unknown field`,
        ]);
    });

    test("a service needs environments, and an environment needs something to do", () => {
        assert.deepEqual(validateOps({ services: { svc: {} } }), ["ops.services.svc.environments: required, an object that maps an environment name to its deploy, runtime and health"]);
        assert.deepEqual(validateOps({ services: { svc: { environments: {} } } }), ["ops.services.svc.environments: must be an object that maps an environment name to its deploy, runtime and health"]);
        assert.deepEqual(validateOps({ services: { svc: "x" } }), ["ops.services.svc: must be an object with environments"]);
        assert.deepEqual(validateOps(only({})), ["ops.services.svc.environments.staging: must have at least one of deploy, runtime and health"]);
        assert.deepEqual(validateOps(only("x")), ["ops.services.svc.environments.staging: must be an object with deploy, runtime or health"]);
    });

    test("service and environment names are short plain names", () => {
        const entry = { health: "https://x.example.test/h" };
        for (const name of ["", "-x", "a b", "a/b", "__proto__", "x".repeat(41)]) {
            const errors = validateOps({ services: { [name]: { environments: { staging: entry } } } });
            assert.equal(errors.length, 1, JSON.stringify(name));
            assert.match(errors[0] ?? "", /is not a usable service name/);
        }
        for (const name of ["", "1st", "a b", "-x", "a.b", "x".repeat(41)]) {
            const errors = validateOps({ services: { svc: { environments: { [name]: entry } } } });
            assert.equal(errors.length, 1, JSON.stringify(name));
            assert.match(errors[0] ?? "", /is not a usable environment name/);
        }
    });

    test("repo is text without white space, and ci needs a system", () => {
        for (const repo of ["", "a b", 5, "x".repeat(201), "a\nb"]) {
            const raw = section();
            ((raw.services as Record<string, Raw>)["billing"] as Raw).repo = repo;
            assert.equal(validateOps(raw).length, 1, JSON.stringify(repo));
        }
        const raw = section();
        const billing = (raw.services as Record<string, Raw>)["billing"] as Raw;
        billing.ci = { workflow: "build.yml" };
        assert.deepEqual(validateOps(raw), ["ops.services.billing.ci.system: required, the CI system: github-actions, gitlab, jenkins"]);
        billing.ci = "github-actions";
        assert.match(validateOps(raw)[0] ?? "", /^ops\.services\.billing\.ci: must be an object with a system/);
        billing.ci = { system: "Github Actions" };
        assert.deepEqual(validateOps(raw), ["ops.services.billing.ci.system: unknown CI system; the systems there are: github-actions, gitlab, jenkins"]);
    });

    test("every problem is reported, not just the first", () => {
        const raw = withEntry("orders-api", "staging", { context: "-x", namespace: "N", selector: "x", port: 0, color: "red" });
        const errors = validateOps({ ...raw, extra: 1 });
        assert.ok(errors.length >= 6, errors.join("\n"));
        assert.ok(errors.every((line) => /^ops\./.test(line)));
    });

    test("an error never repeats the value it refused", () => {
        const secretish = "TOK CANARY;91ac7";
        const refusals: Raw[] = [
            ...["context", "namespace", "selector", "container", "port", "healthPath"].map((key) => withEntry("orders-api", "staging", { [key]: secretish })),
            ...["release", "chart", "valuesFile", "set"].map((key) => withDeploy("orders-api", "staging", { [key]: secretish })),
            withDeploy("orders-api", "staging", { set: { replicas: secretish } }),
            withDeploy("orders-api", "staging", { method: secretish }),
            withEnvironment("orders-api", "production", { health: secretish }),
            withEnvironment("orders-api", "production", { health: `https://user:${secretish}@x.example.test/h` }),
            withEnvironment("billing", "staging", { deploy: { method: "kubectl-image", workload: secretish, container: secretish } }),
        ];
        for (const raw of refusals) {
            const errors = validateOps(raw);
            assert.equal(errors.length > 0, true, JSON.stringify(raw));
            assert.ok(errors.every((line) => !line.includes(secretish) && !line.includes("91ac7")), errors.join("\n"));
        }
    });
});

describe("the deploy method of an environment", () => {
    const deploy = (change: Raw) => validateOps(withDeploy("orders-api", "staging", change));
    const at = "ops.services.orders-api.environments.staging.deploy";

    test("has a method, helm or kubectl-image", () => {
        assert.deepEqual(validateOps(withEnvironment("orders-api", "staging", { deploy: {} })), [`${at}.method: required, helm or kubectl-image`]);
        assert.deepEqual(validateOps(withEnvironment("orders-api", "staging", { deploy: { method: "ansible" } })), [`${at}.method: must be helm or kubectl-image`]);
        assert.deepEqual(validateOps(withEnvironment("orders-api", "staging", { deploy: "helm" })), [`${at}: must be an object with a method: helm or kubectl-image`]);
    });

    test("helm needs a release and a chart, and the release is a Helm release name", () => {
        const bare = withEnvironment("orders-api", "staging", { deploy: { method: "helm" } });
        assert.deepEqual(validateOps(bare), [
            `${at}.release: required, a Helm release name: lower case letters, digits and -, up to 53 characters, such as orders-api`,
            `${at}.chart: required, the chart, such as deploy/chart or acme/orders-api`,
        ]);
        for (const release of ["", "Orders", "-orders", "orders-", "or ders", "a_b", "x".repeat(54), 5, null]) {
            assert.match(deploy({ release })[0] ?? "", /^ops\..*deploy\.release: must be a Helm release name/, JSON.stringify(release));
        }
        assert.deepEqual(deploy({ release: "x".repeat(53) }), []);
    });

    test("a chart and a values file are a folder, a repository chart or an address: no white space, and nothing helm could read as a flag", () => {
        for (const chart of ["deploy/chart", "./chart", "/abs/chart", "acme/orders-api", "oci://registry.example.test/charts/orders"]) {
            assert.deepEqual(deploy({ chart }), [], chart);
        }
        for (const bad of ["", "-f", "--set=x", "a b", "a\nb", "a\u0000b", 5, "x".repeat(301)]) {
            assert.match(deploy({ chart: bad })[0] ?? "", /\.chart: must be the chart/, JSON.stringify(bad));
            assert.match(deploy({ valuesFile: bad })[0] ?? "", /\.valuesFile: must be a values file/, JSON.stringify(bad));
        }
        assert.deepEqual(deploy({ valuesFile: "deploy/values-staging.yaml" }), []);
    });

    test("set holds Helm values: plain text, numbers and booleans, and never the image tag, which is the version's", () => {
        assert.deepEqual(deploy({ set: { replicaCount: 2, "ingress.host": "orders.staging.example.com", debug: true, "resources.limits.cpu": "500m", "tolerations[0].key": "spot" } }), []);
        assert.match(deploy({ set: { "image.tag": "1.0.0" } })[0] ?? "", /deploy\.set\.image\.tag: the deploy sets this from the version it is given, so it cannot be set here$/);
        assert.match(deploy({ set: { "1bad": "x" } })[0] ?? "", /deploy\.set: "1bad" is not a usable Helm value name$/);
        assert.match(deploy({ set: { "a b": "x" } })[0] ?? "", /is not a usable Helm value name$/);
        // Helm reads commas, braces and backslashes in a value, so a value that holds one would not be what it says.
        for (const value of ["a,b=c", "{a,b}", "a\\b", "has space", "x".repeat(201), null, [], {}, Number.NaN]) {
            assert.match(deploy({ set: { key: value } })[0] ?? "", /deploy\.set\.key: must be a number, a boolean or text of letters, digits and/, JSON.stringify(value));
        }
        assert.match(deploy({ set: "x" })[0] ?? "", /deploy\.set: must be an object of Helm values/);
        assert.deepEqual(deploy({ set: Object.fromEntries(Array.from({ length: 21 }, (_, n) => [`k${n}`, "v"])) }), [`${at}.set: at most 20 values`]);
    });

    test("kubectl-image needs a workload of a kind the rollout code reads, and a container", () => {
        const image = (change: Raw) => validateOps(withEnvironment("billing", "staging", { deploy: { method: "kubectl-image", workload: "deployment/billing", container: "billing", ...change } }));
        assert.deepEqual(image({}), []);
        assert.deepEqual(image({ workload: "statefulset/ledger.v2" }), []);
        for (const workload of ["billing", "pod/billing", "daemonset/billing", "deployment/", "deployment/Billing", "deployment/-x", "deployment/a b", 5, "deployment/x/y"]) {
            assert.match(image({ workload })[0] ?? "", /\.workload: must be deployment\/<name> or statefulset\/<name>, such as deployment\/orders-api$/, JSON.stringify(workload));
        }
        for (const container of ["", "Main", "-main", "a_b", "x".repeat(64), 5]) {
            assert.deepEqual(image({ container }), ["ops.services.billing.environments.staging.deploy.container: must be a container name of that workload"], JSON.stringify(container));
        }
        const bare = withEnvironment("billing", "staging", { deploy: { method: "kubectl-image" } });
        assert.deepEqual(validateOps(bare), [
            "ops.services.billing.environments.staging.deploy.workload: required, deployment/<name> or statefulset/<name>, such as deployment/orders-api",
            "ops.services.billing.environments.staging.deploy.container: required, a container name of that workload",
        ]);
        assert.deepEqual(image({ release: "x" }), ["ops.services.billing.environments.staging.deploy.release: unknown field"]);
    });

    test("either method deploys to a cluster, so it needs the environment's Kubernetes runtime", () => {
        const deployOnly = { deploy: { method: "helm", release: "orders-api", chart: "deploy/chart" }, health: "https://x.example.test/h" };
        assert.deepEqual(validateOps(only(deployOnly)), [
            "ops.services.svc.environments.staging.deploy: deploys to a Kubernetes cluster, so the environment needs runtime.kubernetes (the context and the namespace)",
        ]);
        assert.deepEqual(validateOps(only({ ...deployOnly, runtime: { kubernetes: KUBERNETES } })), []);
    });
});

describe("the runtime of an environment", () => {
    const kubernetes = (change: Raw) => validateOps(withEntry("billing", "staging", change));
    const at = "ops.services.billing.environments.staging.runtime";

    test("names a runtime there is: kubernetes", () => {
        assert.deepEqual(validateOps(only({ runtime: { compose: {} } })), ["ops.services.svc.environments.staging.runtime.compose: unknown runtime; the runtimes there are: kubernetes"]);
        assert.deepEqual(validateOps(only({ runtime: {} })), ["ops.services.svc.environments.staging.runtime: must name a runtime: kubernetes"]);
        assert.deepEqual(validateOps(only({ runtime: "kubernetes" })), ["ops.services.svc.environments.staging.runtime: must be an object that names a runtime: kubernetes"]);
        assert.deepEqual(validateOps(only({ runtime: { kubernetes: "x" } })), ["ops.services.svc.environments.staging.runtime.kubernetes: must be an object with context, namespace and selector"]);
    });

    test("context, namespace and selector are all needed, and each error names its key", () => {
        assert.deepEqual(validateOps(only({ runtime: { kubernetes: {} } })), [
            "ops.services.svc.environments.staging.runtime.kubernetes.context: required, a kubectl context name, such as prod-cluster",
            "ops.services.svc.environments.staging.runtime.kubernetes.namespace: required, a namespace name, such as orders",
            "ops.services.svc.environments.staging.runtime.kubernetes.selector: required, a label selector for the pods, such as app=orders-api",
        ]);
    });

    test("a context is a name, and never something kubectl could read as a flag", () => {
        for (const context of ["", "-n", "--server=x", "has space", "semi;colon", "a\nb", 5, null, ["x"]]) {
            const errors = kubernetes({ context });
            assert.equal(errors.length, 1, JSON.stringify(context));
            assert.match(errors[0] ?? "", /^ops\.services\.billing\.environments\.staging\.runtime\.kubernetes\.context: must be a kubectl context name/);
        }
    });

    test("a namespace and a container are Kubernetes names", () => {
        for (const namespace of ["Orders", "-orders", "orders-", "or ders", "a".repeat(64), "orders.prod", ""]) {
            assert.equal(kubernetes({ namespace }).length, 1, JSON.stringify(namespace));
        }
        for (const container of ["Main", "-main", "main_app", "x".repeat(64), ""]) {
            assert.deepEqual(kubernetes({ container }), [`${at}.kubernetes.container: must be a container name`], JSON.stringify(container));
        }
    });

    test("a selector is key=value pairs, equality only, so what kubectl gets is what workloads are matched with", () => {
        const refused = ["", "app", "app=", "=x", "app!=x", "app in (a,b)", "!app", "app=a b", "-l=x", "app=a,", ",app=a", "app==x", "a=b;c=d"];
        for (const selector of refused) {
            const errors = kubernetes({ selector });
            assert.equal(errors.length, 1, JSON.stringify(selector));
            assert.match(errors[0] ?? "", /\.selector: must be 1 to 10 comma-separated key=value pairs/);
        }
        assert.equal(kubernetes({ selector: Array.from({ length: 11 }, (_, n) => `k${n}=v`).join(",") }).length, 1);
        assert.deepEqual(kubernetes({ selector: Array.from({ length: 10 }, (_, n) => `k${n}=v`).join(",") }), []);
        assert.equal(kubernetes({ selector: 5 }).length, 1);
    });

    test("a health check in a pod needs a path, a port and a container together: none of them alone", () => {
        assert.deepEqual(kubernetes({ container: "billing", port: 8080, healthPath: "/health" }), []);
        assert.deepEqual(kubernetes({ container: "billing" }), [], "a container alone is for logs");
        assert.deepEqual(kubernetes({ port: 8080, container: "billing" }), [`${at}.kubernetes.healthPath: required with port, the path of the health check`]);
        assert.deepEqual(kubernetes({ healthPath: "/health", container: "billing" }), [`${at}.kubernetes.port: required with healthPath, the port the service listens on in the pod`]);
        assert.deepEqual(kubernetes({ healthPath: "/health", port: 8080 }), [`${at}.kubernetes.container: required with healthPath and port, the container curl runs in`]);
    });

    test("a port is a whole number from 1 to 65535", () => {
        for (const port of [0, 65536, 80.5, "8080", -1, null, Number.NaN]) {
            assert.deepEqual(
                kubernetes({ port, container: "billing", healthPath: "/h" }),
                [`${at}.kubernetes.port: must be a whole number from 1 to 65535`],
                String(port),
            );
        }
        for (const port of [1, 65535]) assert.deepEqual(kubernetes({ port, container: "billing", healthPath: "/h" }), []);
    });

    test("a health path is at most 400 characters of the usual set, one optional query, and no ..", () => {
        const good = ["/", "/x", "/a/b-c_d.e~f", "/a;b$c'(d)*+,=:@%20!&", "/x?y=1", "/x?", "/?a=b", `/${"a".repeat(400)}`, `/x?${"a".repeat(400)}`, "//double/slash", "/%e2%82%ac"];
        const inPod = { container: "billing", port: 8080 };
        for (const healthPath of good) assert.deepEqual(kubernetes({ ...inPod, healthPath }), [], healthPath);
        const bad = [
            "", "x", "x/y", "?a=1", " /x", "/x ", "/a b", "/a\nb", "/a\tb", "/a\u0000b", "/é", "/a\\b", "/a#b", "/a?b?c", "/a[0]", "/a{b}", "/a|b", "/a<b", '/a"b', "/a`b", "/a^b",
            `/${"a".repeat(401)}`, `/x?${"a".repeat(401)}`, "http://other.test/x", 5,
        ];
        for (const healthPath of bad) {
            assert.match(kubernetes({ ...inPod, healthPath })[0] ?? "", /\.healthPath: must start with \/ and hold only letters/, JSON.stringify(healthPath));
        }
    });

    test("a health path that climbs is refused, however it is written", () => {
        const climbing = [
            "/..", "/a/../b", "/a/..", "/../etc", "/a..b", "/a/%2e%2e/b", "/a/%2E%2E/b", "/a/.%2e/b", "/a/%2e./b", "/a/%252e%252e/b", "/a/%25252e%25252e/b",
            "/a/%2525252e%2525252e/b", "/x?next=../y", "/x?next=%2e%2e", "/a/%252e./b", "/%2e%2e",
        ];
        for (const healthPath of climbing) {
            assert.match(kubernetes({ container: "billing", port: 8080, healthPath })[0] ?? "", /\.healthPath: must start with \//, healthPath);
        }
    });

    test("a path that is still changing after five rounds of decoding is refused", () => {
        // A dot written as %2e, then with its percent sign written as %25 again and again: four rounds of decoding still
        // leave a change to make, and a server that decodes that far would see "..".
        const nested = (depth: number) => `/a/%${"25".repeat(depth - 1)}2e`;
        const inPod = { container: "billing", port: 8080 };
        assert.equal(kubernetes({ ...inPod, healthPath: nested(5) }).length, 1);
        assert.equal(kubernetes({ ...inPod, healthPath: nested(9) }).length, 1);
        assert.deepEqual(kubernetes({ ...inPod, healthPath: nested(4) }), [], "a dot nested four deep settles, and is no climb");
        assert.deepEqual(kubernetes({ ...inPod, healthPath: "/a/%2520b" }), [], "decoding settles after two rounds");
    });
});

describe("the health address of an environment", () => {
    const health = (address: unknown) => validateOps(withEnvironment("billing", "staging", { health: address }));

    test("is an https address, and may have a path and a query", () => {
        for (const address of ["https://api.example.test/health", "https://api.example.test", "https://api.example.test:8443/a/b?full=1", "HTTPS://API.EXAMPLE.TEST/h", "https://10.0.0.5/health"]) {
            assert.deepEqual(health(address), [], address);
        }
    });

    test("is never plain http, whatever the host", () => {
        for (const address of ["http://api.example.test/health", "http://localhost:8080/health", "http://127.0.0.1/health", "ftp://x.test/h", "//x.test/h", "api.example.test/health", "", 5, null, "https://", "https:///x"]) {
            assert.match(health(address)[0] ?? "", /\.health: must be an https address, such as https:\/\/api\.staging\.example\.com\/orders\/health$/, JSON.stringify(address));
        }
    });

    test("holds no credential and no fragment, and no control character", () => {
        assert.match(health("https://user:pw@api.example.test/h")[0] ?? "", /\.health: must not contain a user name or password$/);
        assert.match(health("https://user@api.example.test/h")[0] ?? "", /must not contain a user name or password$/);
        assert.match(health("https://api.example.test/h#frag")[0] ?? "", /\.health: must not contain a fragment$/);
        assert.match(health("https://api.example.test/h\n")[0] ?? "", /must be an https address/);
        assert.match(health(`https://api.example.test/${"a".repeat(500)}`)[0] ?? "", /must be an https address/);
    });

    test("healthProblem is the same check, for the request to ask again", () => {
        assert.equal(healthProblem("https://api.example.test/h"), undefined);
        assert.match(healthProblem("http://api.example.test/h") ?? "", /^must be an https address/);
        assert.equal(healthProblem("https://u:p@x.test/"), "must not contain a user name or password");
    });
});

describe("the catalog of a loaded section", () => {
    test("catalogOf reads a valid section and nothing else", () => {
        assert.ok(catalogOf(section()));
        assert.equal(catalogOf(undefined), undefined);
        assert.equal(catalogOf("x"), undefined);
        assert.equal(catalogOf([]), undefined);
        assert.equal(catalogOf(section({ unknown: 1 })), undefined, "a section with an error reads as absent");
    });

    test("catalogOf reads a section once, and again when it is another object", () => {
        const raw = section();
        assert.equal(catalogOf(raw), catalogOf(raw));
        assert.notEqual(catalogOf(raw), catalogOf(section()));
    });
});

describe("finding the environment of a call", () => {
    test("returns the environment of a service", () => {
        assert.equal(findEnvironment(catalog(), "runtime", "orders-api", "production").kubernetes?.namespace, "orders");
        assert.equal(findEnvironment(catalog(), "deploy", "billing", "staging").kubernetes?.context, "test-cluster");
    });

    test("an unknown service is invalid input, and the message lists the services with their environments, led by the tool", () => {
        assert.throws(
            () => findEnvironment(catalog(), "runtime", "nope", "staging"),
            (error: unknown) =>
                error instanceof TypeError &&
                error.message === 'runtime: no service named "nope". Known services: orders-api (staging, production), billing (staging)',
        );
        for (const service of [undefined, null, 5, ["orders-api"], {}]) {
            assert.throws(() => findEnvironment(catalog(), "deploy", service, "staging"), /^InputError: deploy: no service named /);
        }
    });

    test("an unknown environment is invalid input, and the message lists the service's environments", () => {
        assert.throws(
            () => findEnvironment(catalog(), "runtime", "orders-api", "qa"),
            (error: unknown) => error instanceof TypeError && error.message === 'runtime: orders-api has no environment "qa". Known environments: staging, production',
        );
        assert.throws(() => findEnvironment(catalog(), "runtime", "billing", "production"), /billing has no environment "production"\. Known environments: staging$/);
        for (const environment of [undefined, null, 5, ["staging"]]) {
            assert.throws(() => findEnvironment(catalog(), "runtime", "billing", environment), /^InputError: runtime: billing has no environment /);
        }
    });

    test("a long list of services is cut, so a message stays short", () => {
        const services = Object.fromEntries(
            Array.from({ length: 40 }, (_, n) => [`service-number-${n}`, { environments: { staging: { health: "https://x.example.test/h" } } }]),
        );
        const text = describeServices(catalog({ services }));
        assert.ok(text.length < 220, text);
        assert.match(text, /\(and \d+ more\)$/);
    });
});
