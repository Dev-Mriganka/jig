// The `k8s` section: what is accepted, what is refused and how each refusal reads, and how a call finds its service.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeServices, findTarget, readK8s, settingsOf, validateK8s } from "../src/runtime/kubernetes/config.ts";
import type { K8sSettings } from "../src/runtime/kubernetes/config.ts";
import { section, withEntry } from "./support/section.ts";

function settings(raw: unknown = section()): K8sSettings {
    const read = readK8s(raw);
    assert.deepEqual(read.errors, []);
    assert.ok(read.settings);
    return read.settings;
}

describe("a valid section", () => {
    test("has no errors and reads into targets by service and environment", () => {
        assert.deepEqual(validateK8s(section()), []);
        const read = settings();
        assert.deepEqual([...read.services.keys()], ["orders-api", "billing"]);
        assert.deepEqual([...(read.services.get("orders-api")?.keys() ?? [])], ["staging", "production"]);
        assert.deepEqual(read.services.get("orders-api")?.get("staging"), {
            service: "orders-api",
            environment: "staging",
            jigEnvironment: "staging",
            context: "test-cluster",
            namespace: "orders-staging",
            selector: "app=orders-api",
            labels: [["app", "orders-api"]],
            container: "orders-api",
            port: 8080,
        });
    });

    test("leaves container and port out when the entry has none: they are needed only by api", () => {
        const target = settings().services.get("orders-api")?.get("production");
        assert.equal(target?.container, undefined);
        assert.equal(target?.port, undefined);
        assert.equal("container" in (target ?? {}), false);
        assert.deepEqual(target?.labels, [["app", "orders-api"], ["tier", "web"]]);
    });

    test("an environment is known to jig-core by its own name unless `environments` maps it", () => {
        const plain = settings();
        assert.equal(plain.services.get("orders-api")?.get("production")?.jigEnvironment, "production");
        const mapped = settings(section({ environments: { production: "prod", staging: "qa" } }));
        assert.equal(mapped.services.get("orders-api")?.get("production")?.jigEnvironment, "prod");
        assert.equal(mapped.services.get("orders-api")?.get("staging")?.jigEnvironment, "qa");
        assert.equal(mapped.services.get("billing")?.get("staging")?.jigEnvironment, "qa", "one mapping for every service");
    });

    test("a name such as constructor is only a name", () => {
        const raw = { services: { constructor: { staging: { context: "c", namespace: "n", selector: "app=x" } } } };
        const read = settings(raw);
        assert.equal(read.services.get("constructor")?.get("staging")?.service, "constructor");
        assert.equal(read.services.get("toString"), undefined);
        assert.throws(() => findTarget(read, "toString", "staging"), TypeError);
        assert.throws(() => findTarget(read, "constructor", "valueOf"), TypeError);
    });

    test("accepts the context names clouds use, and names with a namespace in them", () => {
        for (const context of ["prod-cluster", "arn:aws:eks:eu-west-1:123456789012:cluster/prod", "user@cluster.example.test", "gke_proj_zone_name", "a"]) {
            assert.deepEqual(validateK8s(withEntry("billing", "staging", { context })), [], context);
        }
    });

    test("accepts selectors with several pairs and labels that have a prefix", () => {
        for (const selector of ["app=orders-api", "app=a,tier=web", "app.kubernetes.io/name=orders-api", "k8s-app=orders_api.v2"]) {
            assert.deepEqual(validateK8s(withEntry("billing", "staging", { selector })), [], selector);
        }
    });
});

describe("a section that is refused", () => {
    test("must be an object with services", () => {
        assert.deepEqual(validateK8s(undefined), ["k8s: must be an object"]);
        assert.deepEqual(validateK8s([]), ["k8s: must be an object"]);
        assert.deepEqual(validateK8s("services"), ["k8s: must be an object"]);
        assert.deepEqual(validateK8s({}), ["k8s.services: required, an object that maps a service name to its environments"]);
        assert.deepEqual(validateK8s({ services: [] }), ["k8s.services: must be an object that maps a service name to its environments"]);
        assert.deepEqual(validateK8s({ services: {} }), ["k8s.services: must name 1 to 100 services"]);
    });

    test("an unknown field is an error that names its key, at every level", () => {
        assert.deepEqual(validateK8s(section({ cluster: "x" })), ["k8s.cluster: unknown field"]);
        assert.deepEqual(validateK8s(withEntry("orders-api", "staging", { namespce: "x" })), [
            "k8s.services.orders-api.staging.namespce: unknown field",
        ]);
        assert.deepEqual(validateK8s(withEntry("billing", "staging", { kubeconfig: "/x", server: "https://x.test" })), [
            "k8s.services.billing.staging.kubeconfig: unknown field",
            "k8s.services.billing.staging.server: unknown field",
        ]);
    });

    test("context, namespace and selector are all needed, and each error names its key", () => {
        const raw = { services: { svc: { staging: {} } } };
        assert.deepEqual(validateK8s(raw), [
            "k8s.services.svc.staging.context: required, a kubectl context name, such as prod-cluster",
            "k8s.services.svc.staging.namespace: required, a namespace name, such as orders",
            "k8s.services.svc.staging.selector: required, a label selector for the pods, such as app=orders-api",
        ]);
        assert.deepEqual(validateK8s({ services: { svc: { staging: "x" } } }), [
            "k8s.services.svc.staging: must be an object with context, namespace and selector",
        ]);
        assert.deepEqual(validateK8s({ services: { svc: {} } }), [
            "k8s.services.svc: must be an object that maps an environment name to { context, namespace, selector }",
        ]);
    });

    test("a context is a name, and never something kubectl could read as a flag", () => {
        for (const context of ["", "-n", "--server=x", "has space", "semi;colon", "a\nb", 5, null, ["x"]]) {
            const errors = validateK8s(withEntry("billing", "staging", { context }));
            assert.equal(errors.length, 1, JSON.stringify(context));
            assert.match(errors[0] ?? "", /^k8s\.services\.billing\.staging\.context: must be a kubectl context name/);
        }
    });

    test("a namespace and a container are Kubernetes names", () => {
        for (const namespace of ["Orders", "-orders", "orders-", "or ders", "a".repeat(64), "orders.prod", ""]) {
            assert.equal(validateK8s(withEntry("billing", "staging", { namespace })).length, 1, JSON.stringify(namespace));
        }
        for (const container of ["Main", "-main", "main_app", "x".repeat(64), ""]) {
            const errors = validateK8s(withEntry("billing", "staging", { container }));
            assert.deepEqual(errors, ["k8s.services.billing.staging.container: must be a container name"], JSON.stringify(container));
        }
    });

    test("a port is a whole number from 1 to 65535", () => {
        for (const port of [0, 65536, 80.5, "8080", -1, null, Number.NaN]) {
            assert.deepEqual(
                validateK8s(withEntry("billing", "staging", { port })),
                ["k8s.services.billing.staging.port: must be a whole number from 1 to 65535"],
                String(port),
            );
        }
        assert.deepEqual(validateK8s(withEntry("billing", "staging", { port: 65535 })), []);
        assert.deepEqual(validateK8s(withEntry("billing", "staging", { port: 1 })), []);
    });

    test("a selector is key=value pairs, equality only, so what kubectl gets is what workloads are matched with", () => {
        const refused = ["", "app", "app=", "=x", "app!=x", "app in (a,b)", "!app", "app=a b", "-l=x", "app=a,", ",app=a", "app==x", "a=b;c=d"];
        for (const selector of refused) {
            const errors = validateK8s(withEntry("billing", "staging", { selector }));
            assert.equal(errors.length, 1, JSON.stringify(selector));
            assert.match(errors[0] ?? "", /^k8s\.services\.billing\.staging\.selector: must be 1 to 10 comma-separated key=value pairs/);
        }
        const eleven = Array.from({ length: 11 }, (_, n) => `k${n}=v`).join(",");
        assert.equal(validateK8s(withEntry("billing", "staging", { selector: eleven })).length, 1);
        assert.deepEqual(validateK8s(withEntry("billing", "staging", { selector: Array.from({ length: 10 }, (_, n) => `k${n}=v`).join(",") })), []);
        assert.equal(validateK8s(withEntry("billing", "staging", { selector: 5 })).length, 1);
    });

    test("service and environment names are short plain names", () => {
        const entry = { context: "c", namespace: "n", selector: "app=x" };
        for (const name of ["", "-x", "a b", "a/b", "__proto__", "x".repeat(41)]) {
            const errors = validateK8s({ services: { [name]: { staging: entry } } });
            assert.equal(errors.length, 1, JSON.stringify(name));
            assert.match(errors[0] ?? "", /is not a usable service name/);
        }
        for (const name of ["", "1st", "a b", "-x", "a.b", "x".repeat(41)]) {
            const errors = validateK8s({ services: { svc: { [name]: entry } } });
            assert.equal(errors.length, 1, JSON.stringify(name));
            assert.match(errors[0] ?? "", /is not a usable environment name/);
        }
    });

    test("every problem is reported, not just the first", () => {
        const raw = section({ extra: 1 });
        const services = raw.services as Record<string, Record<string, Record<string, unknown>>>;
        (services["orders-api"] as Record<string, Record<string, unknown>>).staging = { context: "-x", namespace: "N", selector: "x", port: 0, color: "red" };
        const errors = validateK8s(raw);
        assert.equal(errors.length, 6, errors.join("\n"));
        assert.ok(errors.every((line) => /^k8s\./.test(line)));
    });

    test("an error never repeats the value it refused", () => {
        const secretish = "TOK CANARY;91ac7";
        for (const key of ["context", "namespace", "selector", "container", "port"]) {
            const errors = validateK8s(withEntry("billing", "staging", { [key]: secretish }));
            assert.equal(errors.length > 0, true, key);
            assert.ok(errors.every((line) => !line.includes(secretish)), key);
        }
    });
});

describe("the environments mapping", () => {
    test("maps names to jig-core environment names", () => {
        assert.deepEqual(validateK8s(section({ environments: { production: "prod" } })), []);
        assert.deepEqual(validateK8s(section({ environments: {} })), []);
    });

    test("is an object of names", () => {
        assert.deepEqual(validateK8s(section({ environments: "x" })), [
            "k8s.environments: must be an object that maps an environment name to a jig-core environment name",
        ]);
        assert.deepEqual(validateK8s(section({ environments: { staging: 5 } })), [
            "k8s.environments.staging: must be the name of a jig-core environment, such as staging",
        ]);
        assert.deepEqual(validateK8s(section({ environments: { staging: "bad name" } })), [
            "k8s.environments.staging: must be the name of a jig-core environment, such as staging",
        ]);
        assert.match(validateK8s(section({ environments: { "bad name": "x" } }))[0] ?? "", /is not a usable environment name/);
    });

    test("a mapping for an environment no service has is a typo, and is an error", () => {
        assert.deepEqual(validateK8s(section({ environments: { stagng: "staging" } })), [
            "k8s.environments.stagng: no service has an environment of this name",
        ]);
    });
});

describe("the settings of a loaded section", () => {
    test("settingsOf reads a valid section and nothing else", () => {
        assert.ok(settingsOf(section()));
        assert.equal(settingsOf(undefined), undefined);
        assert.equal(settingsOf("x"), undefined);
        assert.equal(settingsOf([]), undefined);
        assert.equal(settingsOf(section({ unknown: 1 })), undefined, "a section with an error reads as absent");
    });

    test("settingsOf reads a section once, and again when it is another object", () => {
        const raw = section();
        assert.equal(settingsOf(raw), settingsOf(raw));
        assert.notEqual(settingsOf(raw), settingsOf(section()));
    });
});

describe("finding the target of a call", () => {
    test("returns the target of a service in an environment", () => {
        assert.equal(findTarget(settings(), "orders-api", "production").namespace, "orders");
        assert.equal(findTarget(settings(), "billing", "staging").context, "test-cluster");
    });

    test("an unknown service is invalid input, and the message lists the services with their environments", () => {
        assert.throws(
            () => findTarget(settings(), "nope", "staging"),
            (error: unknown) =>
                error instanceof TypeError &&
                error.message === 'k8s: no service named "nope". Known services: orders-api (staging, production), billing (staging)',
        );
        for (const service of [undefined, null, 5, ["orders-api"], {}]) {
            assert.throws(() => findTarget(settings(), service, "staging"), /^InputError: k8s: no service named /);
        }
    });

    test("an unknown environment is invalid input, and the message lists the service's environments", () => {
        assert.throws(
            () => findTarget(settings(), "orders-api", "qa"),
            (error: unknown) =>
                error instanceof TypeError && error.message === 'k8s: orders-api has no environment "qa". Known environments: staging, production',
        );
        assert.throws(() => findTarget(settings(), "billing", "production"), /billing has no environment "production"\. Known environments: staging$/);
        for (const environment of [undefined, null, 5, ["staging"]]) {
            assert.throws(() => findTarget(settings(), "billing", environment), /^InputError: k8s: billing has no environment /);
        }
    });

    test("a long list of services is cut, so a message stays short", () => {
        const services = Object.fromEntries(
            Array.from({ length: 40 }, (_, n) => [`service-number-${n}`, { staging: { context: "c", namespace: "n", selector: "app=x" } }]),
        );
        const text = describeServices(settings({ services }));
        assert.ok(text.length < 220, text);
        assert.match(text, /\(and \d+ more\)$/);
    });
});
