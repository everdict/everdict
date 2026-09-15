import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatasetSchema, RuntimeSpecSchema, storedExecutionId } from "@everdict/contracts";
import { loadHarnessTaxonomyDir } from "@everdict/registry";
import { describe, expect, it } from "vitest";

// Guards the first-party harness taxonomy presets (examples/harness-templates) — that templates+instances match the
// schema and resolve (guarding against broken presets). These are reference presets a workspace can register; they are
// no longer auto-seeded into _shared on boot, so this guards their validity directly (loadHarnessTaxonomyDir defaults owner to _shared).
const HARNESS_DIR = fileURLToPath(new URL("../../../../../examples/harness-templates", import.meta.url));
const DATASET_DIR = fileURLToPath(new URL("../../../../../examples/datasets", import.meta.url));
const RUNTIME_DIR = fileURLToPath(new URL("../../../../../examples/runtimes", import.meta.url));

describe("first-party harness taxonomy seed", () => {
  it("templates+instances in examples/harness-templates load into _shared and resolve", async () => {
    const { instances } = await loadHarnessTaxonomyDir(HARNESS_DIR);
    const list = await instances.list(storedExecutionId("any-tenant")); // _shared fallback
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

  // ── THE FIRST-PARTY CODING-AGENT RECIPES ARE CONVERSATIONAL (harness-definability-spec.md §3) ──────
  it("codex and claude-code-router resolve as command harnesses carrying a conversation contract and a build recipe", async () => {
    const { templates, instances } = await loadHarnessTaxonomyDir(HARNESS_DIR);
    for (const id of ["codex", "claude-code-router"]) {
      const resolved = await instances.get("t", id);
      expect(resolved.kind).toBe("command");
      if (resolved.kind !== "command") continue;
      // A registered recipe that cannot resume is one no delegation profile can use; the contract has to survive
      // the template → instance resolution, which is the door registration actually uses.
      expect(resolved.conversation?.resume).toContain("{{resume}}");
      expect(resolved.command).toContain("{{conversation}}");
      // The code recipe and its maintainer live on the TEMPLATE — the build lane and the delegate resolver read it there.
      const template = await templates.get("t", id, "1");
      expect(template.kind).toBe("command");
      if (template.kind !== "command") continue;
      expect(template.source?.git).toMatch(/^https:\/\/github\.com\//);
      expect(template.source?.maintainer?.profile).toBeDefined();
      expect(template.build?.steps.length).toBeGreaterThan(0);
    }
  });

  it("an os-use desktop agent (command, workDir) instance resolves", async () => {
    const { instances } = await loadHarnessTaxonomyDir(HARNESS_DIR);
    const agent = await instances.get("t", "desktop-ssh-agent");
    expect(agent.kind).toBe("command");
    expect(agent.kind === "command" && agent.workDir).toBe("/tmp"); // os-use has no work, so it needs an absolute path
  });
});

// Guards that the first-party dataset/runtime example catalogs are schema-valid (reference files — not auto-seeded,
// and nothing loads them from a directory: a workspace registers what it wants through the API).
const readJson = (dir: string, file: string): unknown => JSON.parse(readFileSync(join(dir, file), "utf8"));

describe("first-party dataset·runtime example catalogs", () => {
  it("every examples/datasets file parses, and the os-use benchmark (hermes-desktop-ssh, multi-case) is intact", () => {
    const datasets = readdirSync(DATASET_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => DatasetSchema.parse(readJson(DATASET_DIR, file)));
    expect(datasets.length).toBeGreaterThan(0);
    const ds = datasets.find((d) => d.id === "hermes-desktop-ssh");
    expect(ds, "examples/datasets no longer carries hermes-desktop-ssh").toBeDefined();
    if (ds === undefined) return;
    expect(ds.cases.length).toBeGreaterThanOrEqual(2); // scorecard batch (multiple cases)
    expect(ds.cases.map((c) => c.id)).toEqual(["hermes-ssh-connect", "hermes-open-settings"]);
    expect(ds.cases.every((c) => c.env.kind === "os-use")).toBe(true);
    expect(ds.cases.every((c) => c.image === "everdict-hermes-dispatch:demo")).toBe(true); // image drives container execution (runtime is chosen at submit time)
    expect(ds.cases.every((c) => c.graders.some((g) => g.id === "judge" && g.config?.useScreenshot === true))).toBe(
      true,
    );
  });

  // Reference example (not auto-seeded — workspaces register runtimes themselves): only ensures the file parses schema-valid.
  it("the examples/runtimes example file parses (reference — not auto-seeded)", () => {
    const rt = RuntimeSpecSchema.parse(readJson(RUNTIME_DIR, "local-1.0.0.json"));
    expect(rt.id).toBe("local");
    expect(rt.kind).toBe("local");
  });
});
