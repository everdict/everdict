import { z } from "zod";

// One declarative payload predicate — filters AND together against a platform event's pointer payload
// (e.g. { field: "passRate", op: "lt", value: 1 } = "the batch had failing cases").
//
// This lives on its own so every surface that selects events shares ONE grammar: an agent's declarative triggers
// (AgentTriggerSchema), an E3 subscription's selector, and a conversation's wake intent (a waiting agent picks the
// events that should resume it). `@everdict/domain` eventSelectorMatches is the single matcher over all three —
// a second grammar would mean a second matcher, and the two would drift.
export const EventSelectorFilterSchema = z
  .object({
    field: z.string().min(1),
    op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "exists"]),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(), // required for every op except "exists"
  })
  .strict();
export type EventSelectorFilter = z.infer<typeof EventSelectorFilterSchema>;
