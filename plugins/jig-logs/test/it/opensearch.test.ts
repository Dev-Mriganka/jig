// jig-logs against OpenSearch 2, which has the same search API as Elasticsearch. The node runs with its security plugin
// off, so it speaks plain HTTP and has no sign-in, and requests travel through a transport (see loki.test.ts).
import { before } from "node:test";
import { describeIt, must } from "../../../../test/support/it.ts";
import { baseTime, dataset, runName } from "../support/dataset.ts";
import { plainTransport, realWorld } from "../support/real.ts";
import { dropIndex, seedIndex, send } from "../support/seed.ts";
import { after } from "node:test";
import { commonTests, elasticTests } from "./suite.ts";
import type { Flavor } from "./suite.ts";

describeIt(
    "jig-logs against OpenSearch 2",
    {
        service: "opensearch",
        variables: ["JIG_IT_OPENSEARCH_URL"],
        hint: "a single-node OpenSearch 2 with its security plugin disabled",
    },
    () => {
        const run = runName();
        const base = baseTime();
        const index = `jig-it-${run}`;
        const altIndex = `${index}-alt`;
        const url = () => must("JIG_IT_OPENSEARCH_URL");

        const flavor: Flavor = {
            name: "OpenSearch",
            base,
            exactCounts: true,
            twoAttemptsQuery: 'message:"payment timeout" AND message:(attempt AND (1 OR 2))',
            anyOfQuery: "message:(created OR accepted)",
            malformedQuery: "message:(unclosed",
            world(t, options = {}) {
                const w = realWorld(t, {
                    section: {
                        backend: { url: url(), transport: "plain", ...options.backend },
                        environments: {
                            staging: { index, filter: { env: "staging" } },
                            listed: { index, filter: { env: "staging", service: ["orders-api", "billing-api"] } },
                            prod: { index, filter: { env: "prod" }, jigEnvironment: "production" },
                            ...options.environments,
                        },
                    },
                    ...(options.now === undefined ? {} : { now: options.now }),
                });
                w.jig.transports.set("plain", plainTransport);
                return w;
            },
        };

        before(async () => {
            const info = JSON.parse(await send({ url: url() }, "GET", "/"));
            console.log(`OpenSearch ${info.version.number} (Lucene ${info.version.lucene_version})`);
            const lines = dataset(base);
            await seedIndex({ url: url() }, index, lines);
            await seedIndex({ url: url() }, altIndex, lines, { time: "ts", message: "msg", epoch: true });
        });

        after(async () => {
            await dropIndex({ url: url() }, index);
            await dropIndex({ url: url() }, altIndex);
        });

        commonTests(flavor);
        elasticTests(flavor, { index: altIndex });
    },
);
