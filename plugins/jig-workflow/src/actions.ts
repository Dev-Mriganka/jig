// What each action of the `workflow` tool does. An action changes a ticket's state only through the plugin: it asks for a run, an
// approval or a check, and records the outcome. It never records a claim. The actions are in one file for each family, and this file
// puts them back under one name for tool.ts and commands.ts:
//   action-support.ts  what they share: the parameters, the ticket, the started workflow
//   action-start.ts    list, status, start and bind
//   action-plan.ts     submit-plan and scenario
//   action-tests.ts    test
//   action-stages.ts   advance and back
export * from "./action-plan.ts";
export * from "./action-stages.ts";
export * from "./action-start.ts";
export * from "./action-support.ts";
export * from "./action-tests.ts";
