import type { FetchLike } from "@assay/datasets";
import { InMemoryDatasetRegistry } from "@assay/registry";
import { describe, expect, it } from "vitest";
import { BenchmarkService } from "./benchmark-service.js";

// HF datasets-server /rows 응답을 흉내내는 가짜 fetch(네트워크 없이 결정적 테스트).
const HF_ROW = { id: "q1", question: "2+2?", answer: "4" };
const fakeFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ rows: [{ row: HF_ROW }], num_rows_total: 1 }),
});

function svc() {
  const datasets = new InMemoryDatasetRegistry();
  const service = new BenchmarkService({ datasets, fetchImpl: fakeFetch });
  return { service, datasets };
}

describe("BenchmarkService — 소스 미리보기 + 인라인 spec 인입(위저드)", () => {
  it("previewSource(huggingface) 는 매핑 전 감지된 필드와 샘플 행을 돌려준다", async () => {
    const { service } = svc();
    const { fields, rows } = await service.previewSource({
      tenant: "acme",
      source: { kind: "huggingface", dataset: "openai/gsm8k" },
    });
    expect(fields).toEqual(expect.arrayContaining(["id", "question", "answer"]));
    expect(rows[0]).toMatchObject({ question: "2+2?" });
  });

  it("previewSource(jsonl) 는 text 앞줄을 파싱해 필드를 감지한다(limit 적용)", async () => {
    const { service } = svc();
    const text = '{"id":"a","ques":"hi","answer":"x"}\n{"id":"b","ques":"yo","answer":"y"}';
    const { fields, rows } = await service.previewSource({ tenant: "acme", source: { kind: "jsonl" }, text, limit: 5 });
    expect(fields).toEqual(expect.arrayContaining(["id", "ques", "answer"]));
    expect(rows).toHaveLength(2);
  });

  it("인라인 spec 으로 레시피 등록 없이 한 번에 데이터셋으로 인입된다(위저드의 한-번-액션)", async () => {
    const { service, datasets } = svc();
    const rec = await service.import({
      tenant: "acme",
      version: "1.0.0",
      spec: {
        id: "my-bench",
        version: "1.0.0",
        category: "qa",
        source: { kind: "huggingface", dataset: "openai/gsm8k" },
        mapping: { idField: "id", taskField: "question", answerField: "answer" },
      },
    });
    expect(rec).toMatchObject({ workspace: "acme", id: "my-bench", cases: 1 });
    // 데이터셋 레지스트리에 실제 등록됨 — task 가 question 필드에서 매핑.
    const ds = await datasets.get("acme", "my-bench", "1.0.0");
    expect(ds.cases).toHaveLength(1);
    expect(ds.cases[0]?.task).toBe("2+2?");
  });
});
