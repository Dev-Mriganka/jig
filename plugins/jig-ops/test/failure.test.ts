// The complaints of kubectl and helm as one line that says what to do.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explain, firstLines } from "../src/runtime/kubernetes/failure.ts";
import { rig } from "./support/rig.ts";

const r = rig();
const target = r.target();
r.close();

const message = (stderr: string, code = 1, what = "kubectl get") => explain(stderr, code, what, target).message;

describe("a sign-in that kubectl cannot use", () => {
    test("is the user's to fix, and names the context", () => {
        for (const stderr of [
            "Unable to connect to the server: getting credentials: exec: executable aws failed with exit code 255\nThe SSO session associated with this profile has expired. Token has expired",
            "error: ExpiredToken: the security token included in the request is expired",
            "error: You must be logged in to the server (Unauthorized)",
            "Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin not found",
            "error: Unable to locate credentials. You can configure credentials by running aws configure",
        ]) {
            assert.match(message(stderr), /^kubectl is not signed in to context test-cluster \(.+\): the user signs in again for that context outside Pi, then retry$/, stderr);
        }
    });

    test("shows only the first line of the complaint", () => {
        const text = message("error: Token has expired\nsecond line\nthird line");
        assert.match(text, /\(error: Token has expired\)/);
        assert.doesNotMatch(text, /second line/);
    });
});

describe("a cluster that cannot be reached", () => {
    test("says to check the network or VPN, and to retry once it is back, naming the service", () => {
        for (const stderr of [
            "Unable to connect to the server: dial tcp: lookup abc.example.test: no such host",
            "Unable to connect to the server: net/http: TLS handshake timeout",
            "dial tcp 10.0.0.1:443: i/o timeout",
            "The connection to the server localhost:8080 was refused - did you specify the right host or port?",
            "Unable to connect to the server: context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
            "dial tcp 10.0.0.1:443: connect: network is unreachable",
            "dial tcp 10.0.0.1:443: connect: no route to host",
        ]) {
            assert.equal(
                message(stderr),
                "Cannot reach the cluster of context test-cluster for orders-api in staging: check the network or VPN, and retry once it is back",
                stderr,
            );
        }
    });

    test("is told apart from a sign-in problem that starts like it", () => {
        assert.match(message("Unable to connect to the server: getting credentials: exec: Token has expired"), /^kubectl is not signed in/);
    });
});

describe("a configuration that does not match the cluster", () => {
    test("a context the kubeconfig lacks says which setting to fix", () => {
        assert.equal(
            message('error: context "test-cluster" does not exist'),
            'kubectl has no context test-cluster (orders-api in staging): fix "context" in the ops catalog of jig.json (runtime.kubernetes), or add the context to the kubeconfig',
        );
    });

    test("a namespace the cluster lacks says which setting to fix", () => {
        assert.equal(
            message('Error from server (NotFound): namespaces "orders-staging" not found'),
            'Namespace orders-staging does not exist in context test-cluster: fix "namespace" in the ops catalog of jig.json (runtime.kubernetes)',
        );
    });

    test("a user who may not read is told to tell the user", () => {
        assert.match(
            message('Error from server (Forbidden): pods is forbidden: User "u" cannot list resource "pods" in the namespace "orders-staging"'),
            /^The kubeconfig user is not allowed to read orders-api in staging \(Error from server \(Forbidden\): pods is forbidden.*\): tell the user$/,
        );
    });
});

describe("a user who may not change the cluster", () => {
    test("is told so for a change, not for a read", () => {
        const stderr = 'Error from server (Forbidden): deployments.apps "orders-api" is forbidden: User "u" cannot patch resource "deployments"';
        assert.match(explain(stderr, 1, "kubectl set", target, "change").message, /^The kubeconfig user is not allowed to change orders-api in staging \(/);
        assert.match(explain(stderr, 1, "kubectl get", target).message, /^The kubeconfig user is not allowed to read orders-api in staging \(/);
    });
});

describe("what helm says", () => {
    const helm = (stderr: string) => explain(stderr, 1, "helm upgrade", target, "change").message;

    test("a cluster it cannot reach is the network's to fix", () => {
        assert.equal(
            helm('Error: Kubernetes cluster unreachable: Get "https://10.0.0.1/version": dial tcp 10.0.0.1:443: i/o timeout'),
            "Cannot reach the cluster of context test-cluster for orders-api in staging: check the network or VPN, and retry once it is back",
        );
    });

    test("a release that an interrupted deploy left locked is the user's to look at, and is not retried", () => {
        assert.equal(
            helm("Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress"),
            "helm says another operation on the release of orders-api in staging is in progress: an interrupted deploy leaves it locked. Nothing was retried; tell the user, who looks at the release with helm",
        );
    });

    test("a release that does not exist says which setting to check", () => {
        for (const stderr of ["Error: release: not found", "Error: UPGRADE FAILED: \"orders-api\" has no deployed releases"]) {
            assert.match(helm(stderr), /^helm has no such release for orders-api in staging \(.+\): it was never deployed with helm there, or "release" in the ops catalog of jig.json is wrong$/, stderr);
        }
    });

    test("a chart it cannot find says to fix the chart or the folder Pi starts in", () => {
        for (const stderr of ['Error: path "deploy/chart" not found', 'Error: chart "orders" matching  not found in acme index. (try \'helm repo update\')', "Error: failed to download \"acme/orders\""]) {
            assert.match(helm(stderr), /^helm cannot find the chart \(.+\): fix "chart" in the ops catalog of jig.json, or start Pi in the folder a relative chart path is read from$/, stderr);
        }
    });
});

describe("a pod that changed under the call", () => {
    test("a pod that is gone says to list the pods again", () => {
        assert.equal(message('Error from server (NotFound): pods "orders-api-0" not found'), "The pod is gone: it was replaced after it was listed. Run pods again");
    });

    test("a container that has not started says to wait or to read its last run", () => {
        assert.match(
            message('Error from server (BadRequest): container "orders-api" in pod "orders-api-0" is waiting to start: CrashLoopBackOff'),
            /^The container is not running yet \(Error from server \(BadRequest\): container "orders-api" in pod "orders-api-0" is waiting to start: CrashLoopBackOff\): try again shortly, or read the log of its last run with previous: true$/,
        );
        assert.match(message('container "x" in pod "y" is waiting to start: ContainerCreating'), /^The container is not running yet/);
    });

    test("a pod that never restarted has no previous log", () => {
        assert.equal(
            message('Error from server (BadRequest): previous terminated container "orders-api" in pod "orders-api-0" not found'),
            "The pod has no previous container log: its container has not restarted",
        );
    });
});

describe("anything else", () => {
    test("is the command, its exit code and the first lines of the complaint", () => {
        assert.equal(message("error: something odd\nsecond\nthird\nfourth", 2), "kubectl get failed (exit 2): error: something odd; second; third");
        assert.equal(message("", 3, "kubectl logs"), "kubectl logs failed (exit 3): no error text");
    });

    test("never repeats a user name or a password in an address", () => {
        const text = message("error: something odd at https://user:s3cr3t@host.invalid/x\nsecond", 2);
        assert.equal(text, "kubectl get failed (exit 2): error: something odd at https://host.invalid/x; second");
        assert.equal(firstLines("see ssh://deploy:pw@git.example.test/repo.git"), "see ssh://git.example.test/repo.git");
    });

    test("a very long complaint is cut", () => {
        assert.ok(message(`error: ${"x".repeat(2000)}`, 2).length < 450);
    });

    test("a complaint of megabytes costs no more than a short one", () => {
        for (const stderr of ["a".repeat(8 * 1024 * 1024), "line\n".repeat(1_000_000), "a://".repeat(500_000), `${"a".repeat(4 * 1024 * 1024)}://x@y`]) {
            const started = Date.now();
            const text = message(stderr, 2);
            // Generous, because the whole suite loads the machine: a quadratic pass over megabytes takes far longer.
            assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
            assert.ok(text.length < 450);
        }
    });

    test("only the first lines are looked at, and the rest is never repeated", () => {
        const text = message(`first\nsecond\n\n   \nthird\nfourth-CANARY\nfifth-CANARY`, 2);
        assert.equal(text, "kubectl get failed (exit 2): first; second; third");
    });
});
