import { BadRequestError, type CapabilitySpec, type EffectContract } from "@everdict/contracts";

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

// ── Invocation time: what a DECLARATION means for the gate ───────────────────────────────────────────
// The registration guard above makes authors state their effects; this is what reading them is FOR. An
// agent's permission gate used to classify risk by NAME PREFIX (delete_/remove_/revoke_/…), which is a
// guess about a string — `sync_inventory` looks benign and can bill a customer, while `remove_label`
// looks alarming and undoes itself. A capability that told us its blast radius should not then be graded
// on its spelling.
//
// GUARDED means "keep asking a human even in auto mode". Four independent reasons, any one sufficient:
export function effectsRequireConsent(effects: EffectContract): boolean {
  // ① It leaves the boundary. An external effect is the one everdict cannot undo on the caller's behalf.
  if (effects.sideEffect === "external") return true;
  // ② A retry is not free. Absent idempotency is UNKNOWN, and unknown is not a smaller risk — a mutation
  //    nobody promised was safe to repeat gets the same treatment as one declared unsafe.
  if (effects.sideEffect === "workspace" && effects.idempotent !== true) return true;
  // ③ The author said it cannot be undone, and wrote the consent requirement down. Reading that is the
  //    entire reason the tagged form exists.
  if (typeof effects.rollback === "object" && effects.rollback.kind === "irreversible") return true;
  // ④ Data leaves the boundary. Orthogonal to sideEffect on purpose: a READ tool that can reach an outside
  //    network is exfiltration-shaped, and "sideEffect: none" is a true statement about the wrong axis.
  if (effects.dataAccess?.egress === "external") return true;
  return false;
}
