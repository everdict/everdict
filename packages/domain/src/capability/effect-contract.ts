import { BadRequestError, type CapabilitySpec } from "@everdict/contracts";

// The O4 registration guard: a WRITE-capable tool capability (a code tool with isReadOnly=false, an MCP
// server with write=true) must declare its effect contract — blast radius, idempotency, rollback, partial
// failure. Refused at save, because an undeclared side effect is not a smaller side effect: it is the same
// effect with nobody accountable for undoing it. Read-only capabilities and non-tool kinds (skill/
// environment/delegation) pass untouched; a declared contract on a read-only tool is fine (documentation).
export function assertCapabilityEffects(spec: CapabilitySpec): void {
  const writeCapable =
    (spec.type === "code" && spec.isReadOnly === false) || (spec.type === "mcp" && spec.write === true);
  if (!writeCapable) return;
  const effects = spec.type === "code" || spec.type === "mcp" ? spec.effects : undefined;
  if (!effects) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { type: spec.type },
      "a write-capable capability must declare its effect contract (effects: sideEffect/idempotent/rollback) — an undeclared side effect is the same effect with nobody accountable for undoing it.",
    );
  }
  if (effects.sideEffect === "none") {
    throw new BadRequestError(
      "BAD_REQUEST",
      { type: spec.type },
      'a write-capable capability cannot declare sideEffect "none" — if it truly has no effect, mark it read-only instead.',
    );
  }
  // External blast radius demands the undo story up front — an agent inheriting this tool must know how one
  // invocation is rolled back BEFORE the first invocation, not during the incident.
  if (effects.sideEffect === "external" && effects.rollback === undefined) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { type: spec.type },
      "an external-side-effect capability must declare `rollback` — how one invocation is undone is decided before the first invocation, not during the incident.",
    );
  }
}
