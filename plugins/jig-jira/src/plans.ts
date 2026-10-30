// Which planner builds the plan for which write.
import type { Env } from "./api.ts";
import type { Call } from "./params.ts";
import type { Plan } from "./plan.ts";
import { planComment, planDeleteComment, planEditComment } from "./plan-comment.ts";
import { planCreate } from "./plan-create.ts";
import { planTransition, planUpdate } from "./plan-issue.ts";
import { InputError } from "./values.ts";

/** Builds the plan for a write. `preview` is true when a person will read it, which is when it also looks for duplicates. */
export function buildPlan(env: Env, call: Call, preview: boolean): Promise<Plan> {
    switch (call.action) {
        case "create": return planCreate(env, call, preview);
        case "comment": return planComment(env, call);
        case "edit_comment": return planEditComment(env, call);
        case "delete_comment": return planDeleteComment(env, call);
        case "transition": return planTransition(env, call);
        case "update": return planUpdate(env, call);
        default: throw new InputError(`jira ${call.action} is a read, so it has no plan`);
    }
}
