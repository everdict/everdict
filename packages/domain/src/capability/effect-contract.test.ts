import type { CapabilitySpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { assertCapabilityEffects, effectsRequireConsent } from "./effect-contract.js";

// The O4 acceptance queries (B4 battery): org-affecting capabilities declare their effects or are refused.

const codeTool = (over: Partial<Extract<CapabilitySpec, { type: "code" }>> = {}): CapabilitySpec => ({
  type: "code",
  language: "node",
  code: "export default () => {}",
  parametersSchema: {},
  isReadOnly: false,
  requiredSecrets: [],
  examples: [],
  ...over,
});

describe("assertCapabilityEffects — undeclared side effects cannot register", () => {
  it("a write-capable code tool without an effect contract is refused", () => {
    expect(() => assertCapabilityEffects(codeTool())).toThrow(/effect contract/);
  });

  it('a write-capable tool claiming sideEffect "none" is refused — mark it read-only instead', () => {
    expect(() => assertCapabilityEffects(codeTool({ effects: { sideEffect: "none" } }))).toThrow(/read-only/);
  });

  it("an EXTERNAL side effect must declare rollback — the undo story precedes the first invocation", () => {
    expect(() => assertCapabilityEffects(codeTool({ effects: { sideEffect: "external", idempotent: false } }))).toThrow(
      /rollback/,
    );
    expect(() =>
      assertCapabilityEffects(
        codeTool({
          effects: {
            sideEffect: "external",
            idempotent: false,
            rollback: "call the delete endpoint with the returned id",
            partialFailure: "a created-but-unconfigured resource; list by tag to find strays",
          },
        }),
      ),
    ).not.toThrow();
  });

  it("read-only tools and non-tool kinds pass untouched", () => {
    expect(() => assertCapabilityEffects(codeTool({ isReadOnly: true }))).not.toThrow();
    expect(() => assertCapabilityEffects({ type: "skill", instructions: "do the thing", files: [] })).not.toThrow();
  });
});

describe("assertCapabilityEffects — the tagged rollback forms", () => {
  it("accepts a declared-irreversible rollback: an author who cannot undo it says so, in the type", () => {
    expect(() =>
      assertCapabilityEffects(
        codeTool({
          effects: {
            sideEffect: "external",
            idempotent: false,
            rollback: { kind: "irreversible", requiresApproval: true },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("keeps accepting the prose form — every contract stored before the tagged forms still parses", () => {
    expect(() =>
      assertCapabilityEffects(
        codeTool({ effects: { sideEffect: "external", rollback: "call the delete endpoint with the returned id" } }),
      ),
    ).not.toThrow();
  });
});

// What READING the declaration is for (O4): the invocation-time gate classifies from what the author stated.
describe("effectsRequireConsent — the gate reads the declaration, not the name", () => {
  it("an external effect always asks — it is the one everdict cannot undo for the caller", () => {
    expect(effectsRequireConsent({ sideEffect: "external", idempotent: true, rollback: "undo it" })).toBe(true);
  });

  it("a workspace mutation asks unless idempotency was PROMISED — unknown is not a smaller risk", () => {
    expect(effectsRequireConsent({ sideEffect: "workspace" })).toBe(true);
    expect(effectsRequireConsent({ sideEffect: "workspace", idempotent: false })).toBe(true);
    expect(effectsRequireConsent({ sideEffect: "workspace", idempotent: true })).toBe(false);
  });

  it("a declared-irreversible rollback asks even when the call itself is idempotent", () => {
    expect(
      effectsRequireConsent({
        sideEffect: "workspace",
        idempotent: true,
        rollback: { kind: "irreversible", requiresApproval: true },
      }),
    ).toBe(true);
  });

  it("external EGRESS asks even with no side effect — reading and sending are the two halves of exfiltration", () => {
    expect(effectsRequireConsent({ sideEffect: "none", dataAccess: { reads: "workspace", egress: "external" } })).toBe(
      true,
    );
    expect(effectsRequireConsent({ sideEffect: "none", dataAccess: { reads: "workspace", egress: "none" } })).toBe(
      false,
    );
  });
});
