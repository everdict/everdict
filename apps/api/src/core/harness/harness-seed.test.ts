import { fileURLToPath } from "node:url";
import { loadDatasetDir, loadHarnessTaxonomyDir, loadRuntimeDir } from "@everdict/registry";
import { describe, expect, it } from "vitest";

// Guards that the first-party harness taxonomy (examples/harness-templates) loads into _shared — that templates+instances
// match the schema and resolve (guarding against broken presets) + identical to what main.ts seedSharedHarnessTaxonomy serves.
const HARNESS_DIR = fileURLToPath(new URL("../../../../../examples/harness-templates", import.meta.url));
const DATASET_DIR = fileURLToPath(new URL("../../../../../examples/datasets", import.meta.url));
const RUNTIME_DIR = fileURLToPath(new URL("../../../../../examples/runtimes", import.meta.url));

describe("first-party harness taxonomy seed", () => {
  it("templates+instances in examples/harness-templates load into _shared and resolve", async () => {
    const { instances } = await loadHarnessTaxonomyDir(HARNESS_DIR);
    const list = await instances.list("any-tenant"); // _shared fallback
    const ids = list.map((h) => h.id).sort();
    expect(ids).toContain("aider"); // command instance (declarative CLI agent)
    expect(ids).toContain("bu"); // service instance (topology)
    expect(list.every((h) => h.owner === "_shared")).toBe(true);
  });

  it("both command and service kinds resolve", async () => {
    const { instances } = await loadHarnessTaxonomyDir(HARNESS_DIR);
    const aider = await instances.get("t", "aider"); // not owned → _shared fallback
    expect(aider.kind).toBe("command");
    const bu = await instances.get("t", "bu");
    expect(bu.kind).toBe("service");
  });

  it("an os-use desktop agent (command, workDir) instance resolves", async () => {
    const { instances } = await loadHarnessTaxonomyDir(HARNESS_DIR);
    const agent = await instances.get("t", "desktop-ssh-agent");
    expect(agent.kind).toBe("command");
    expect(agent.kind === "command" && agent.workDir).toBe("/tmp"); // os-use has no work, so it needs an absolute path
  });
});

// Guards that the first-party dataset/runtime catalogs also load schema-valid (served by seedSharedDatasets/Runtimes).
describe("first-party dataset·runtime catalog seed", () => {
  it("examples/datasets parses and the os-use benchmark (hermes-desktop-ssh, multi-case) is in _shared", async () => {
    const reg = await loadDatasetDir(DATASET_DIR);
    const ds = await reg.get("any-tenant", "hermes-desktop-ssh"); // _shared fallback
    expect(ds.cases.length).toBeGreaterThanOrEqual(2); // scorecard batch (multiple cases)
    expect(ds.cases.map((c) => c.id)).toEqual(["hermes-ssh-connect", "hermes-open-settings"]);
    expect(ds.cases.every((c) => c.env.kind === "os-use")).toBe(true);
    expect(ds.cases.every((c) => c.image === "everdict-hermes-dispatch:demo")).toBe(true); // image drives container execution (runtime is chosen at submit time)
    expect(ds.cases.every((c) => c.graders.some((g) => g.id === "judge" && g.config?.useScreenshot === true))).toBe(
      true,
    );
  });

  // Reference example (not auto-seeded — workspaces register runtimes themselves): only ensures the file parses schema-valid.
  it("the examples/runtimes example file parses (reference — not auto-seeded)", async () => {
    const reg = await loadRuntimeDir(RUNTIME_DIR);
    const rt = await reg.get("any-tenant", "local");
    expect(rt.kind).toBe("local");
  });
});
