// The only place jig-acme reaches into Jig's source: the contract's types. The re-export is types only, so it is erased at
// run time and this package never imports a Jig module; at run time it uses the global handle in ./client.ts.
//
// This example lives inside the Jig repository, so the path below is a relative one. A company plugin in a repository of its own
// points this file at a checkout of Jig instead: link one next to the plugin (a `.jig` folder, as jig-core's own neighbours do)
// and write `export type * from "../../.jig/plugins/jig-core/src/contract.ts";`. A copy of contract.ts works as well, until
// the contract changes.
export type * from "../../../../plugins/jig-core/src/contract.ts";
