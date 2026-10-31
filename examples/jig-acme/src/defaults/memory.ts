// Defaults for `memory`. A real company puts here the pattern of its ticket keys, so that a key in the conversation starts the ticket's
// folder, notes and recall by itself. It may also set where ticket folders live (`folder`).
//
// A key must not touch a letter or a digit on either side. For several projects, write an alternative: `(ACME|PLAT)-\\d+`.
export const memoryDefaults = {
    ticketPattern: "ACME-\\d+",
};
