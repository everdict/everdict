import { DatasetSchema } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { importBenchmark, importCsv, importJsonl, importWebVoyager, parseCsv } from "./index.js";

describe("importWebVoyager", () => {
  const jsonl = [
    '{"web_name":"Example","id":"ex--0","web":"https://example.com","ques":"What is the h1?","answer":"Example Domain"}',
    '{"web_name":"Wikipedia","id":"wiki--0","web":"https://en.wikipedia.org/wiki/Python","ques":"Release year?","answer":"1991"}',
  ].join("\n");

  it("WebVoyager jsonl → tenant-owned Dataset (EvalCase[] + answer-match + steps)", () => {
    const ds = importWebVoyager(jsonl, { id: "webvoyager", version: "1.0.0", description: "wv" });
    expect(DatasetSchema.safeParse(ds).success).toBe(true); // valid Dataset
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

describe("importJsonl (generic mapping)", () => {
  it("connects arbitrary field names to EvalCase via the mapping", () => {
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
  it("no startUrl/answer → a browser env with no startUrl + no graders", () => {
    const ds = importJsonl('{"id":"q1","q":"hi"}', { id: "d", version: "1" }, { idField: "id", taskField: "q" });
    expect(ds.cases[0]?.env).toEqual({ kind: "browser" });
    expect(ds.cases[0]?.graders).toEqual([]);
  });
});

describe("importCsv / parseCsv", () => {
  it("handles commas inside quotes / escaping", () => {
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

// Import truncation regression (import level) — importBenchmark with no explicit limit must map the FULL
// HF dataset; the old importBenchmark default silently capped the viewer path at 100 rows.
describe("importBenchmark full-dataset import", () => {
  it("imports every row when no limit is given (no silent 100-row cap)", async () => {
    const total = 250;
    const fetchImpl = async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const length = Number(new URL(url).searchParams.get("length"));
      const count = Math.max(0, Math.min(length, total - offset));
      const rows = Array.from({ length: count }, (_, i) => ({ row: { id: `t-${offset + i}`, q: "do it" } }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ rows, num_rows_total: total }) };
    };
    const ds = await importBenchmark(
      {
        id: "bench",
        description: "d",
        category: "browser",
        defaultVersion: "1.0.0",
        source: { kind: "huggingface", dataset: "osunlp/Online-Mind2Web" },
        mapping: { idField: "id", taskField: "q", promptEnv: true },
      },
      { id: "bench", version: "1.0.0" },
      { fetchImpl },
    );
    expect(ds.cases).toHaveLength(250);
    expect(ds.cases[249]?.id).toBe("t-249");
  });
});
