import { describe, expect, it } from "vitest";
import type { FetchLike } from "./sources.js";
import { BenchmarkAdapterSpecSchema, importFromSpec, specToAdapter } from "./spec.js";

const hfFetch =
  (rows: Array<Record<string, unknown>>): FetchLike =>
  async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ rows: rows.map((row) => ({ row })), num_rows_total: rows.length }),
  });

describe("BenchmarkAdapterSpec (data definition)", () => {
  it("validates a JSON-serializable spec (category defaults to qa)", () => {
    const parsed = BenchmarkAdapterSpecSchema.parse({
      id: "my-bench",
      version: "1.0.0",
      source: { kind: "huggingface", dataset: "me/mine", split: "test" },
      mapping: { idField: "id", taskField: "q", answerField: "a" },
    });
    expect(parsed.category).toBe("qa");
    // round-trippable (save/restore) — pure data.
    expect(BenchmarkAdapterSpecSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("graderTemplates' {field} is interpolated per-row into the grader config (replacing the code graderBuilder)", async () => {
    const spec = BenchmarkAdapterSpecSchema.parse({
      id: "code-bench",
      version: "1.0.0",
      category: "coding",
      source: { kind: "huggingface", dataset: "me/code", split: "test" },
      mapping: { idField: "iid", taskField: "problem", gitField: "_git", refField: "base" },
      // per-row SWE-bench form as "data": applyPatch is the row's test_patch, cmd is a literal.
      graderTemplates: [
        { id: "command", config: { applyPatch: "{test_patch}", cmd: "python -m pytest -q", metric: "resolved" } },
      ],
    });
    const ds = await importFromSpec(
      spec,
      { id: "code-bench", version: "1.0.0" },
      {
        limit: 1,
        fetchImpl: hfFetch([
          {
            iid: "x-1",
            problem: "fix bug",
            _git: "https://github.com/me/code.git",
            base: "abc",
            test_patch: "diff --git a b\n+T",
          },
        ]),
      },
    );
    const c = ds.cases[0];
    expect(c?.id).toBe("x-1");
    expect(c?.env).toEqual({ kind: "repo", source: { git: "https://github.com/me/code.git", ref: "abc" } });
    const g = c?.graders.find((x) => x.id === "command");
    expect(g?.config).toEqual({ applyPatch: "diff --git a b\n+T", cmd: "python -m pytest -q", metric: "resolved" });
  });

  it("specToAdapter: no graderBuilder without graderTemplates (mapping graders only)", () => {
    const a = specToAdapter(
      BenchmarkAdapterSpecSchema.parse({
        id: "qa",
        version: "1",
        source: { kind: "jsonl" },
        mapping: { idField: "id", taskField: "q", answerField: "a" },
      }),
    );
    expect(a.graderBuilder).toBeUndefined();
    expect(a.source).toEqual({ kind: "jsonl" });
  });

  it("prompt/image/placement mappings are preserved in the recipe so the case is built without first-party (self-serve completeness)", async () => {
    const spec = BenchmarkAdapterSpecSchema.parse({
      id: "qa-full",
      version: "1.0.0",
      source: { kind: "jsonl" },
      mapping: {
        idField: "id",
        taskField: "q",
        answerField: "a",
        answerMode: "exact",
        promptEnv: true,
        image: "my-img:1",
        placement: "docker",
      },
    });
    expect(spec.mapping.promptEnv).toBe(true); // Zod does not strip it
    expect(spec.mapping.placement).toBe("docker");
    const ds = await importFromSpec(
      spec,
      { id: "qa-full", version: "1.0.0" },
      { text: '{"id":"r1","q":"2+2?","a":"4"}' },
    );
    const c = ds.cases[0];
    expect(c?.env).toEqual({ kind: "prompt" }); // prompt env, not the browser default
    expect(c?.image).toBe("my-img:1");
    expect(c?.placement).toEqual({ target: "docker" });
    expect(c?.graders).toContainEqual({ id: "answer-match", config: { expect: "4", mode: "exact" } });
  });

  it("taskTemplate composes task from multiple fields via {field} interpolation (OfficeQA-style, incl. the evidence document URL)", async () => {
    const spec = BenchmarkAdapterSpecSchema.parse({
      id: "officeqa-ish",
      version: "1.0.0",
      source: { kind: "jsonl" },
      mapping: {
        idField: "uid",
        taskField: "question",
        taskTemplate: "{question}\n\nReference document: {source_docs}",
        answerField: "answer",
        promptEnv: true,
      },
    });
    expect(spec.mapping.taskTemplate).toContain("{source_docs}"); // Zod does not strip it
    const ds = await importFromSpec(
      spec,
      { id: "officeqa-ish", version: "1.0.0" },
      {
        text: '{"uid":"q1","question":"What was the total debt for fiscal year 1945?","answer":"258.7","source_docs":"https://fraser.example/tb"}',
      },
    );
    expect(ds.cases[0]?.task).toBe(
      "What was the total debt for fiscal year 1945?\n\nReference document: https://fraser.example/tb",
    );
  });

  it("uses taskField as-is when there is no taskTemplate (existing mapping unchanged)", async () => {
    const ds = await importFromSpec(
      BenchmarkAdapterSpecSchema.parse({
        id: "plain",
        version: "1.0.0",
        source: { kind: "jsonl" },
        mapping: { idField: "id", taskField: "q", promptEnv: true },
      }),
      { id: "plain", version: "1.0.0" },
      { text: '{"id":"r1","q":"2+2?"}' },
    );
    expect(ds.cases[0]?.task).toBe("2+2?");
  });

  it("osUseEnv mapping builds an os-use env (OSWorld-style is self-serve too via the recipe)", async () => {
    const spec = BenchmarkAdapterSpecSchema.parse({
      id: "osworld-ish",
      version: "1.0.0",
      source: { kind: "jsonl" },
      mapping: {
        idField: "id",
        taskField: "q",
        osUseEnv: true,
        osUseSetup: ["Xvfb :99 & sleep 2"],
        display: ":99",
        screenshotPath: "/tmp/s.png",
      },
    });
    const ds = await importFromSpec(
      spec,
      { id: "osworld-ish", version: "1.0.0" },
      { text: '{"id":"o1","q":"open settings"}' },
    );
    expect(ds.cases[0]?.env).toEqual({
      kind: "os-use",
      display: ":99",
      setup: ["Xvfb :99 & sleep 2"],
      screenshotPath: "/tmp/s.png",
    });
  });

  it("fetches the repo file directly instead of the viewer when source.file is set (fallback for datasets the viewer doesn't serve — officeqa-style)", async () => {
    const urls: string[] = [];
    const fileFetch: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => "uid,question,answer\nq1,capital?,paris\n" };
    };
    const spec = BenchmarkAdapterSpecSchema.parse({
      id: "no-viewer",
      version: "1.0.0",
      source: { kind: "huggingface", dataset: "org/no-viewer", file: "data.csv" },
      mapping: { idField: "uid", taskField: "question", answerField: "answer", promptEnv: true },
    });
    expect(spec.source.kind === "huggingface" && spec.source.file).toBe("data.csv"); // Zod does not strip it
    const ds = await importFromSpec(spec, { id: "no-viewer", version: "1.0.0" }, { fetchImpl: fileFetch });
    expect(urls[0]).toContain("/resolve/main/data.csv"); // the resolve API, not datasets-server
    expect(ds.cases).toHaveLength(1);
    expect(ds.cases[0]?.task).toBe("capital?");
  });

  it("jsonl source spec: ingest via opts.text", async () => {
    const spec = BenchmarkAdapterSpecSchema.parse({
      id: "j",
      version: "1",
      source: { kind: "jsonl" },
      mapping: { idField: "id", taskField: "q", answerField: "a" },
    });
    const ds = await importFromSpec(spec, { id: "j", version: "1" }, { text: '{"id":"r1","q":"hi","a":"yes"}' });
    expect(ds.cases[0]?.graders).toEqual([{ id: "answer-match", config: { expect: "yes" } }]);
  });
});
