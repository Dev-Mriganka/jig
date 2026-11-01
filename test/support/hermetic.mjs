// Every test process starts in a world of its own, so a result never depends on the machine it runs on: an empty temporary home,
// git configuration, Pi agent folder, state folder and password store; no cloud or forge credentials; and Pi told to stay offline.
// A test that needs something else sets it itself (and puts it back), as before. The list of what a test can rely on is in
// docs/integration-tests.md, "What a test can rely on".
//
// The integration suites (`npm run test:it`) keep what names their services (`JIG_IT_*`, `NODE_EXTRA_CA_CERTS`), the token that the
// GitHub suites sign in with, and the kubeconfig that the cluster suite reads.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const env = process.env;
const realHome = homedir();

// What a suite that talks to GitHub or to a cluster still needs, decided before anything is removed.
const github = (env.JIG_IT_GITHUB ?? "") !== "" || (env.JIG_IT_GITHUB_REPOSITORY ?? "") !== "";
const kubeconfig =
    (env.JIG_IT_KUBE_CONTEXT ?? "") === "" ? undefined : (env.KUBECONFIG ?? path.join(realHome, ".kube/config"));

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-test-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
for (const name of ["home", "agent", "password-store", "gnupg"]) mkdirSync(path.join(root, name), { mode: 0o700 });
writeFileSync(path.join(root, "gitconfig"), "[user]\n\tname = Jig Test\n\temail = test@example.com\n");

// Credentials, by name and by prefix: cloud accounts, forges, registries, agents that hold keys, and model providers.
const credentials = [
    "GITLAB_TOKEN",
    "GLAB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "DBUS_SESSION_BUS_ADDRESS",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    ...(github ? [] : ["GH_TOKEN", "GITHUB_TOKEN"]),
];
for (const name of Object.keys(env)) {
    if (name.startsWith("AWS_") || name.startsWith("AZURE_") || credentials.includes(name)) delete env[name];
}
delete env.KUBECONFIG;
if (kubeconfig !== undefined) env.KUBECONFIG = kubeconfig;

// A test run from a git hook would otherwise work on the repository that is committing.
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY"])
    delete env[name];
// With these gone, the defaults are under the temporary home.
for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]) {
    delete env[name];
}

env.HOME = path.join(root, "home");
env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
env.GIT_CONFIG_NOSYSTEM = "1";
env.PI_OFFLINE = "1";
env.PI_SKIP_VERSION_CHECK = "1";
env.PI_TELEMETRY = "0";
env.PI_CODING_AGENT_DIR = path.join(root, "agent");
env.JIG_STATE_DIR = path.join(root, "state");
env.PASSWORD_STORE_DIR = path.join(root, "password-store");
env.GNUPGHOME = path.join(root, "gnupg");
