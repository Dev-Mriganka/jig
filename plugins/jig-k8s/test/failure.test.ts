// kubectl's complaints as one line that says what to do.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explain, firstLines } from "../src/failure.ts";
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
            'kubectl has no context test-cluster (orders-api in staging): fix "context" in the k8s section of jig.json, or add the context to the kubeconfig',
        );
    });

    test("a namespace the cluster lacks says which setting to fix", () => {
        assert.equal(
            message('Error from server (NotFound): namespaces "orders-staging" not found'),
            'Namespace orders-staging does not exist in context test-cluster: fix "namespace" in the k8s section of jig.json',
        );
    });

    test("a user who may not read is told to tell the user", () => {
        assert.match(
            message('Error from server (Forbidden): pods is forbidden: User "u" cannot list resource "pods" in the namespace "orders-staging"'),
            /^The kubeconfig user is not allowed to read orders-api in staging \(Error from server \(Forbidden\): pods is forbidden.*\): tell the user$/,
        );
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
});
