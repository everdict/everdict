import { BadRequestError, DatasetSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { harborTaskToCase, harborToDataset } from "./harbor.js";

describe("harborTaskToCase", () => {
  it("maps a full Harbor task → EvalCase (image env + instruction + verifier tests-pass + difficulty tag)", () => {
    const c = harborTaskToCase({
      id: "research-repro",
      instruction: "Reproduce the paper's figure 3 and save it to /app/out.png.",
      image: "ghcr.io/acme/harbor/research-repro:v1",
      verifierCommand: "python /tests/verify.py",
      workdir: "/workspace",
      difficulty: "hard",
      tags: ["research"],
      timeoutSec: 1800,
    });
    expect(c.id).toBe("research-repro");
    expect(c.task).toContain("Reproduce the paper");
    expect(c.image).toBe("ghcr.io/acme/harbor/research-repro:v1");
    expect(c.env).toEqual({ kind: "repo", source: { path: "/workspace" } });
    expect(c.graders).toEqual([{ id: "tests-pass", config: { cmd: "python /tests/verify.py" } }]);
    expect(c.tags).toEqual(["hard", "research"]);
    expect(c.timeoutSec).toBe(1800);
  });

  it("applies defaults for the verifier command, workdir, and timeout", () => {
    const c = harborTaskToCase({ id: "t1", instruction: "do X", image: "img:1" });
    expect(c.env).toEqual({ kind: "repo", source: { path: "/app" } });
    expect(c.graders).toEqual([{ id: "tests-pass", config: { cmd: "bash /tests/verify.sh" } }]);
    expect(c.timeoutSec).toBe(900);
  });

  it("resolves the image from an imageTemplate ({id}) when the task has none", () => {
    const c = harborTaskToCase({ id: "hello", instruction: "x" }, { imageTemplate: "reg/harbor/{id}:v2" });
    expect(c.image).toBe("reg/harbor/hello:v2");
  });

  it("throws when neither an image nor an imageTemplate resolves (references images, never builds)", () => {
    expect(() => harborTaskToCase({ id: "t", instruction: "x" })).toThrow(BadRequestError);
  });

  it("rejects a malformed task (missing instruction)", () => {
    expect(() => harborTaskToCase({ id: "t", image: "img:1" })).toThrow();
  });
});

describe("harborToDataset", () => {
  it("maps a task set → a valid Dataset with a shared imageTemplate + Harbor lineage", () => {
    const ds = harborToDataset(
      [
        { id: "a", instruction: "task a", difficulty: "easy" },
        { id: "b", instruction: "task b", verifierCommand: "pytest -q", tags: ["py"] },
      ],
      { id: "harbor-core", version: "1.0.0", tags: ["agent"] },
      { imageTemplate: "reg.example.com/harbor/{id}:v1" },
    );
    expect(DatasetSchema.safeParse(ds).success).toBe(true);
    expect(ds.producedBy?.id).toBe("harbor");
    expect(ds.cases).toHaveLength(2);
    expect(ds.cases[0]?.image).toBe("reg.example.com/harbor/a:v1");
    expect(ds.cases[1]?.graders).toEqual([{ id: "tests-pass", config: { cmd: "pytest -q" } }]);
  });
});
