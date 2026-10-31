// Defaults for `sandbox`. A real company puts here what its people's shell commands must never reach: hosts to refuse, more places to
// hide.
//
// `network.deny` lists hosts that `bash` can never connect to, in the `filtered` and `ask` network modes (the default mode, `open`,
// filters nothing, and `/sandbox` warns each person whose mode is `open` that the list refuses nothing: a company that wants this to
// bite also defaults `network.mode`, which is a stronger choice for each person than a list of hosts, so this example does not). A host is a name or `*.name`, with an optional `:port`. Production databases belong
// here: the agent reads them through the `mongo` tool, which masks the result and keeps to the allow list, and a shell must not
// go round it.
export const sandboxDefaults = {
    network: { deny: ["mongo.prod.acme.example", "*.db.prod.acme.example"] },
};
