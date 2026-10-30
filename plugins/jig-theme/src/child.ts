/**
 * A subagent child is a short-lived Pi that a parent session started: the subagents extension sets PI_SUBAGENT_ID in it.
 * PI_SUBAGENT_CHILD=1 is the older name, still accepted. Nobody reads a footer there, and it must not write the
 * parent's theme files a second time, so neither is done.
 */
export const isSubagentChild = (env: NodeJS.ProcessEnv = process.env): boolean =>
    (env.PI_SUBAGENT_ID?.trim() ?? "") !== "" || env.PI_SUBAGENT_CHILD === "1";
