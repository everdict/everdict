import { NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildHarnessShape } from "./harness-shape.js";

describe("buildHarnessShape — the candidate's slots for attribution (routing spec §2)", () => {
  const reader = buildHarnessShape({
    harnesses: {
      async get(_t, id) {
        if (id === "shop")
          return {
            kind: "service",
            id,
            version: "1.0.1",
            services: [{ name: "web", owns: { tools: ["browse"] } }, { name: "api" }],
          } as never;
        if (id === "codex") return { kind: "command", id, version: "1.0.1", command: "x" } as never;
        throw new NotFoundError("NOT_FOUND", { id }, "harness not found");
      },
    },
  });
  it("a topology's services with the tools each owns; a command's single image slot; absent when unregistered", async () => {
    expect(await reader.slotsOf("acme", { id: "shop", version: "1.0.1" })).toEqual({
      kind: "read",
      value: [
        { slot: "web", service: "web", tools: ["browse"] },
        { slot: "api", service: "api", tools: [] },
      ],
    });
    expect(await reader.slotsOf("acme", { id: "codex", version: "1.0.1" })).toEqual({
      kind: "read",
      value: [{ slot: "image", tools: [] }],
    });
    expect(await reader.slotsOf("acme", { id: "nope", version: "1" })).toEqual({ kind: "absent" });
  });
});
