import type { AgentTriggerFilter } from "@everdict/contracts";

// The ONE event-selection predicate (event-plumbing.md E3 §6): agent triggers and subscription selectors
// share the same declarative grammar — kinds allowlist + payload filters ANDed together — so matching lives
// here once and every executor (the agent activation engine, the E1 reaction consumer, the T-d workflow
// starter) reads the same law. Pure over the contracts shapes; no I/O.

export interface SelectorEvent {
  kind: string;
  payload?: Record<string, unknown>;
}

export interface EventSelector {
  kinds: readonly string[];
  filters: readonly AgentTriggerFilter[];
}

export function eventSelectorMatches(selector: EventSelector, event: SelectorEvent): boolean {
  if (!selector.kinds.includes(event.kind)) return false;
  const payload = event.payload ?? {};
  return selector.filters.every((filter) => filterPasses(filter, payload));
}

function filterPasses(filter: AgentTriggerFilter, payload: Record<string, unknown>): boolean {
  const actual = payload[filter.field];
  switch (filter.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "eq":
      return actual === filter.value;
    case "neq":
      return actual !== filter.value;
    default: {
      if (typeof actual !== "number" || typeof filter.value !== "number") return false;
      if (filter.op === "lt") return actual < filter.value;
      if (filter.op === "lte") return actual <= filter.value;
      if (filter.op === "gt") return actual > filter.value;
      return actual >= filter.value;
    }
  }
}
