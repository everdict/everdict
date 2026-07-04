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

describe("BenchmarkAdapterSpec (데이터 정의)", () => {
  it("JSON 직렬화 가능 스펙을 검증한다(category 기본 qa)", () => {
    const parsed = BenchmarkAdapterSpecSchema.parse({
      id: "my-bench",
      version: "1.0.0",
      source: { kind: "huggingface", dataset: "me/mine", split: "test" },
      mapping: { idField: "id", taskField: "q", answerField: "a" },
    });
    expect(parsed.category).toBe("qa");
    // 라운드트립(저장/복원) 가능 — 순수 데이터.
    expect(BenchmarkAdapterSpecSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("graderTemplates 의 {field} 가 행별로 보간되어 grader config 가 된다(코드 graderBuilder 대체)", async () => {
    const spec = BenchmarkAdapterSpecSchema.parse({
      id: "code-bench",
      version: "1.0.0",
      category: "coding",
      source: { kind: "huggingface", dataset: "me/code", split: "test" },
      mapping: { idField: "iid", taskField: "problem", gitField: "_git", refField: "base" },
      // per-row SWE-bench 형태를 "데이터"로: applyPatch 는 행의 test_patch, cmd 는 리터럴.
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

  it("specToAdapter: graderTemplates 없으면 graderBuilder 없음(매핑 graders 만)", () => {
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

  it("prompt/image/placement 매핑이 레시피에 보존되어 first-party 없이도 그 케이스를 만든다(self-serve 완전성)", async () => {
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
    expect(spec.mapping.promptEnv).toBe(true); // Zod 가 strip 하지 않는다
    expect(spec.mapping.placement).toBe("docker");
    const ds = await importFromSpec(
      spec,
      { id: "qa-full", version: "1.0.0" },
      { text: '{"id":"r1","q":"2+2?","a":"4"}' },
    );
    const c = ds.cases[0];
    expect(c?.env).toEqual({ kind: "prompt" }); // 브라우저 기본값이 아니라 prompt env
    expect(c?.image).toBe("my-img:1");
    expect(c?.placement).toEqual({ target: "docker" });
    expect(c?.graders).toContainEqual({ id: "answer-match", config: { expect: "4", mode: "exact" } });
  });

  it("taskTemplate 이 여러 필드를 {field} 보간으로 합성해 task 를 만든다(OfficeQA 류 근거 문서 URL 포함)", async () => {
    const spec = BenchmarkAdapterSpecSchema.parse({
      id: "officeqa-ish",
      version: "1.0.0",
      source: { kind: "jsonl" },
      mapping: {
        idField: "uid",
        taskField: "question",
        taskTemplate: "{question}\n\n근거 문서: {source_docs}",
        answerField: "answer",
        promptEnv: true,
      },
    });
    expect(spec.mapping.taskTemplate).toContain("{source_docs}"); // Zod 가 strip 하지 않는다
    const ds = await importFromSpec(
      spec,
      { id: "officeqa-ish", version: "1.0.0" },
      {
        text: '{"uid":"q1","question":"1945 회계연도 총부채는?","answer":"258.7","source_docs":"https://fraser.example/tb"}',
      },
    );
    expect(ds.cases[0]?.task).toBe("1945 회계연도 총부채는?\n\n근거 문서: https://fraser.example/tb");
  });

  it("taskTemplate 이 없으면 taskField 를 그대로 쓴다(기존 매핑 무변경)", async () => {
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

  it("osUseEnv 매핑이 os-use env 를 만든다(레시피로 OSWorld 류도 self-serve)", async () => {
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

  it("jsonl 소스 스펙: opts.text 로 인입", async () => {
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
