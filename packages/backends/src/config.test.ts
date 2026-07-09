import { describe, expect, it } from "vitest";
import { buildRegistry } from "./config.js";

describe("buildRegistry", () => {
  it("registers multiple backends from config and returns the default", () => {
    const { registry, defaultTarget } = buildRegistry({
      default: "nomad-a",
      backends: [
        { name: "dev", kind: "local" },
        { name: "nomad-a", kind: "nomad", addr: "http://a:4646", image: "img", runtime: "runsc" },
      ],
    });
    expect(registry.names().sort()).toEqual(["dev", "nomad-a"]);
    expect(defaultTarget).toBe("nomad-a");
  });
});
