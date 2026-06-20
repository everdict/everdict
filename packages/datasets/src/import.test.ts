import { DatasetSchema } from "@assay/core";
import { describe, expect, it } from "vitest";
import { importCsv, importJsonl, importWebVoyager, parseCsv } from "./index.js";

describe("importWebVoyager", () => {
  const jsonl = [
    '{"web_name":"Example","id":"ex--0","web":"https://example.com","ques":"What is the h1?","answer":"Example Domain"}',
    '{"web_name":"Wikipedia","id":"wiki--0","web":"https://en.wikipedia.org/wiki/Python","ques":"Release year?","answer":"1991"}',
  ].join("\n");

  it("WebVoyager jsonl → 테넌트-소유 Dataset(EvalCase[] + answer-match + steps)", () => {
    const ds = importWebVoyager(jsonl, { id: "webvoyager", version: "1.0.0", description: "wv" });
    expect(DatasetSchema.safeParse(ds).success).toBe(true); // 유효한 Dataset
    expect(ds.id).toBe("webvoyager");
    expect(ds.cases).toHaveLength(2);
    const c0 = ds.cases[0];
    expect(c0?.id).toBe("ex--0");
    expect(c0?.env).toEqual({ kind: "browser", startUrl: "https://example.com" }); // web → startUrl
    expect(c0?.task).toBe("What is the h1?"); // ques → task
    expect(c0?.tags).toEqual(["Example"]); // web_name → tag
    // answer → answer-match grader, + steps
    expect(c0?.graders).toEqual([{ id: "answer-match", config: { expect: "Example Domain" } }, { id: "steps" }]);
  });
});

describe("importJsonl (제너릭 매핑)", () => {
  it("임의 필드명을 매핑으로 EvalCase 에 연결", () => {
    const jsonl = '{"task_id":"t1","prompt":"do X","url":"https://x","gold":"yes"}';
    const ds = importJsonl(
      jsonl,
      { id: "custom", version: "0.1.0" },
      {
        idField: "task_id",
        taskField: "prompt",
        startUrlField: "url",
        answerField: "gold",
      },
    );
    expect(ds.cases[0]?.id).toBe("t1");
    expect(ds.cases[0]?.task).toBe("do X");
    expect(ds.cases[0]?.env).toEqual({ kind: "browser", startUrl: "https://x" });
    expect(ds.cases[0]?.graders).toEqual([{ id: "answer-match", config: { expect: "yes" } }]);
  });
  it("startUrl/answer 없으면 startUrl 없는 browser env + grader 없음", () => {
    const ds = importJsonl('{"id":"q1","q":"hi"}', { id: "d", version: "1" }, { idField: "id", taskField: "q" });
    expect(ds.cases[0]?.env).toEqual({ kind: "browser" });
    expect(ds.cases[0]?.graders).toEqual([]);
  });
});

describe("importCsv / parseCsv", () => {
  it("따옴표 안 쉼표/이스케이프 처리", () => {
    const rows = parseCsv('id,q,ans\n1,"a, b","he said ""hi"""\n2,plain,x');
    expect(rows).toEqual([
      { id: "1", q: "a, b", ans: 'he said "hi"' },
      { id: "2", q: "plain", ans: "x" },
    ]);
  });
  it("CSV → Dataset", () => {
    const ds = importCsv(
      "id,question,expected\nc1,what,42",
      { id: "csvds", version: "1" },
      {
        idField: "id",
        taskField: "question",
        answerField: "expected",
      },
    );
    expect(ds.cases[0]?.id).toBe("c1");
    expect(ds.cases[0]?.graders).toEqual([{ id: "answer-match", config: { expect: "42" } }]);
  });
});
