// The exact lists: what is hidden, locked or ask-first. They are data, so a reader can check them against
// docs/rules.md, which says why each group is there. Paths start with `~/` (the home folder) or are absolute.
// Everything not listed is writable, because an allow-only sandbox breaks every tool that keeps state somewhere
// nobody thought of.

/** A group of paths that share a reason and a way through, as a message says them. */
export interface Group {
    /** The reason in `cannot read X: <reason>`. */
    reason: string;
    /** What to do instead, addressed to the agent. Empty when there is nothing better to say. */
    way: string;
    /** Whether `share` may open a path of this group again. Credentials are the floor: never. */
    floor: boolean;
}

const ASK_THE_USER = "Ask the user for the value you need, or use the tool that holds the secret.";
const BY_HAND = "If you need the change, ask the user to make it themselves with !.";

export const GROUPS = {
    ssh: {
        reason: "it holds credentials",
        way: "For git over SSH use the git tool (fetch, pull, push).",
        floor: true,
    },
    cloud: {
        reason: "it holds credentials",
        way: "Use Jig's runtime and deploy tools or a company tool, or ask the user to run the command with !.",
        floor: true,
    },
    forge: {
        reason: "it holds credentials",
        way: "Use Jig's pr and release actions, or ask the user to run the command with !.",
        floor: true,
    },
    credentials: { reason: "it holds credentials", way: ASK_THE_USER, floor: true },
    agent: { reason: "it holds the login of a coding agent", way: ASK_THE_USER, floor: true },
    packages: {
        reason: "it holds package-registry credentials",
        way: "A build that needs them must run outside the sandbox: ask the user to run it with !.",
        floor: true,
    },
    project: { reason: "it is a secret file of the project", way: ASK_THE_USER, floor: true },
    windows: {
        reason: "it is the Windows drive, where Windows-side tokens live",
        way: "A work folder there can be opened with `share` in the sandbox section of jig.json.",
        floor: false,
    },
    interop: {
        reason: "running a Windows program from here would run it outside the sandbox",
        way: "",
        floor: true,
    },
    sockets: {
        reason: "it holds the sockets of your desktop session and your SSH and GPG agents",
        way: "",
        floor: true,
    },
    docker: {
        reason: "Docker would run anything as root",
        way: "Ask the user to run the docker command with !.",
        floor: true,
    },
    yours: { reason: "you hid it in jig.json", way: "", floor: true },

    shell: { reason: "your shells run it outside the sandbox", way: BY_HAND, floor: false },
    session: { reason: "your desktop session runs it outside the sandbox", way: BY_HAND, floor: false },
    path: { reason: "programs in it run outside the sandbox", way: BY_HAND, floor: false },
    runtime: { reason: "it holds the Node.js and Pi that run outside the sandbox", way: BY_HAND, floor: false },
    git: { reason: "git runs it outside the sandbox", way: BY_HAND, floor: false },
    pi: {
        reason: "Pi and Jig load it outside the sandbox, so a write there could change what they do",
        way: "Use the edit and write tools for files in the project; settings are the user's to change.",
        floor: false,
    },
    hooks: { reason: "git runs hooks outside the sandbox", way: BY_HAND, floor: false },
    agents: { reason: "coding agents run its hooks with no sandbox", way: BY_HAND, floor: false },
    ide: { reason: "your editor runs it outside the sandbox", way: BY_HAND, floor: false },
    build: { reason: "your builds run it, also outside the sandbox", way: BY_HAND, floor: false },
    python: { reason: "Python runs it at start-up, also outside the sandbox", way: BY_HAND, floor: false },
    "yours-locked": { reason: "you locked it in jig.json", way: "", floor: false },

    toolchain: {
        reason: "programs installed there are on your PATH and run outside the sandbox later",
        way: "The user is asked to allow writes there; once they say yes, run the command again.",
        floor: false,
    },
} as const satisfies Record<string, Group>;

export type GroupName = keyof typeof GROUPS;

export interface Listed {
    path: string;
    group: GroupName;
}

const at = (group: GroupName, ...paths: string[]): Listed[] => paths.map((path) => ({ path, group }));

/** Hidden for good, in the home folder. The same credentials jig-core keeps from Pi's file tools, and more. */
export const HIDDEN_IN_HOME: readonly Listed[] = [
    ...at("ssh", "~/.ssh"),
    ...at("credentials", "~/.gnupg", "~/.password-store"),
    ...at("cloud", "~/.aws", "~/.azure", "~/.config/gcloud", "~/.kube"),
    ...at("forge", "~/.config/gh", "~/.config/glab-cli", "~/.config/github-copilot"),
    ...at(
        "credentials",
        "~/.netrc",
        "~/.git-credentials",
        "~/.config/git/credentials",
        "~/.docker/config.json",
        "~/.vault-token",
        "~/.terraform.d/credentials.tfrc.json",
        "~/.config/op",
        "~/.config/1password",
        "~/.config/rclone",
        "~/.pgpass",
        "~/.my.cnf",
        "~/.postman",
        "~/.flyrc",
    ),
    ...at("agent", "~/.claude/.credentials.json", "~/.codex/auth.json"),
    ...at(
        "packages",
        "~/.gradle/gradle.properties",
        "~/.m2/settings.xml",
        "~/.m2/settings-security.xml",
        "~/.npmrc",
        "~/.yarnrc",
        "~/.yarnrc.yml",
        "~/.pypirc",
        "~/.cargo/credentials",
        "~/.cargo/credentials.toml",
        "~/.gem/credentials",
    ),
];

/** Hidden inside Pi's agent folder. */
export const HIDDEN_IN_AGENT_DIR: readonly string[] = ["auth.json", "mcp-auth.json"];

/** Hidden on a Mac only. */
export const HIDDEN_ON_MAC: readonly Listed[] = at("credentials", "~/Library/Keychains");

/** Hidden on WSL: the doors to Windows. */
export const HIDDEN_ON_WSL: readonly Listed[] = [...at("windows", "/mnt"), ...at("interop", "/run/WSL")];

/** The doors to other systems on any Linux. `/run/user/<uid>` is added by the rules, which know the user. */
export const HIDDEN_SOCKETS: readonly Listed[] = [...at("docker", "/var/run/docker.sock", "/run/docker.sock")];

/** The names that make a file in a project secret. A template is not. */
export const PROJECT_SECRET_NAMES: readonly RegExp[] = [
    /^\.env$/,
    /^\.env\..+$/,
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
];
export const PROJECT_SECRET_TEMPLATES: ReadonlySet<string> = new Set([
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
]);

/** Locked, in the home folder: it runs later outside the sandbox. */
export const LOCKED_IN_HOME: readonly Listed[] = [
    ...at(
        "shell",
        "~/.bashrc",
        "~/.bash_profile",
        "~/.bash_login",
        "~/.bash_logout",
        "~/.bash_aliases",
        "~/.profile",
        "~/.zshrc",
        "~/.zshenv",
        "~/.zprofile",
        "~/.zlogin",
        "~/.zlogout",
        "~/.config/fish",
    ),
    ...at(
        "session",
        "~/.config/systemd/user",
        "~/.config/autostart",
        "~/.config/environment.d",
        "~/.xprofile",
        "~/.xinitrc",
        "~/.xsessionrc",
        "~/.tmux.conf",
        "~/.config/tmux",
    ),
    ...at("git", "~/.gitconfig", "~/.config/git"),
    ...at("agents", "~/.agents", "~/.claude/settings.json", "~/.claude/settings.local.json"),
    ...at("build", "~/.gradle/init.gradle", "~/.gradle/init.gradle.kts", "~/.gradle/init.d", "~/.m2/extensions.xml"),
    ...at("build", "~/.cargo/config.toml", "~/.cargo/config", "~/.config/pip/pip.conf", "~/.pip/pip.conf"),
    ...at("path", "~/.npm-global/bin"),
];

/** Locked on a Mac only. */
export const LOCKED_ON_MAC: readonly Listed[] = at("session", "~/Library/LaunchAgents");

/** Locked, in the project and every folder above it below the home folder: what Pi loads. */
export const LOCKED_PI_IN_PROJECT: readonly string[] = [
    ".pi/settings.json",
    ".pi/extensions",
    ".pi/skills",
    ".pi/prompts",
    ".pi/themes",
    ".pi/mcp.json",
    ".agents",
];

/** Locked, in the project and in each repository one and two levels below it. */
export const LOCKED_IN_PROJECT: readonly Listed[] = [
    ...at("agents", ".claude/settings.json", ".claude/settings.local.json"),
    ...at("build", ".mvn/extensions.xml", ".mvn/jvm.config"),
    ...at("ide", ".vscode/tasks.json", ".vscode/settings.json", ".idea/workspace.xml", ".idea/runConfigurations"),
];

/** The toolchain managers: a write there puts a program on PATH, so it asks. */
export const ASK_FIRST: readonly Listed[] = at(
    "toolchain",
    "~/.sdkman",
    "~/.nvm",
    "~/.pyenv",
    "~/.rbenv",
    "~/.rustup",
    "~/.cargo/bin",
    "~/.asdf",
    "~/.local/share/mise",
    "~/.volta",
    "~/.bun",
    "~/.deno",
    "~/go/bin",
);

/**
 * Where a manager keeps its files when its own variable says so, with the folder to ask about (relative to the value).
 * `HOME`-relative defaults are in `ASK_FIRST`; these add the moved ones.
 */
export const ASK_FIRST_BY_ENV: ReadonlyArray<{ variable: string; sub: string }> = [
    { variable: "SDKMAN_DIR", sub: "" },
    { variable: "NVM_DIR", sub: "" },
    { variable: "PYENV_ROOT", sub: "" },
    { variable: "RBENV_ROOT", sub: "" },
    { variable: "RUSTUP_HOME", sub: "" },
    { variable: "CARGO_HOME", sub: "bin" },
    { variable: "ASDF_DATA_DIR", sub: "" },
    { variable: "ASDF_DIR", sub: "" },
    { variable: "VOLTA_HOME", sub: "" },
    { variable: "BUN_INSTALL", sub: "" },
    { variable: "DENO_INSTALL", sub: "" },
    { variable: "GOBIN", sub: "" },
    { variable: "GOPATH", sub: "bin" },
];

/** Git settings that make git run a program or redirect a remote: taken back out after a command. Lower case. */
export const GIT_PLAIN_KEYS: ReadonlySet<string> = new Set([
    "core.sshcommand",
    "core.pager",
    "core.editor",
    "core.askpass",
    "core.hookspath",
    "core.gitproxy",
    "core.fsmonitor",
    "credential.helper",
    "diff.external",
    "protocol.allow",
    "uploadpack.packobjectshook",
    "gpg.program",
    "sequence.editor",
    "include.path",
]);

/** Variables that are dangerous under any subsection (`filter.<name>.clean`), by section. Lower case. */
export const GIT_SUBSECTION_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["credential", new Set(["helper"])],
    ["filter", new Set(["clean", "smudge", "process"])],
    ["diff", new Set(["textconv", "command"])],
    ["merge", new Set(["driver"])],
    ["url", new Set(["insteadof", "pushinsteadof"])],
    ["protocol", new Set(["allow"])],
    ["gpg", new Set(["program"])],
    ["includeif", new Set(["path"])],
]);
