import type { CapabilitySpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { assertCapabilityEffects } from "./effect-contract.js";

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
