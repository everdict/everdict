import { UpstreamError } from "@assay/core";
import type { FetchLike } from "@assay/datasets";
import { InMemoryBenchmarkRegistry, InMemoryDatasetRegistry } from "@assay/registry";
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
    // 인라인 spec 인입도 출처를 남긴다(via:spec) — 데이터셋 상세가 "어떻게 만들어졌는지" 안다.
    expect(ds.producedBy).toEqual({ via: "spec", id: "my-bench" });
  });

  it("등록된 레시피로 인입하면 데이터셋에 producedBy(via:recipe, 해석된 버전)가 스탬프된다", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const benchmarks = new InMemoryBenchmarkRegistry();
    const service = new BenchmarkService({ datasets, benchmarks, fetchImpl: fakeFetch });
    await service.registerRecipe("acme", {
      id: "gsm",
      version: "1.2.0",
      category: "qa",
      source: { kind: "huggingface", dataset: "openai/gsm8k" },
      mapping: { idField: "id", taskField: "question", answerField: "answer" },
    });
    await service.import({ tenant: "acme", version: "1.0.0", recipe: { id: "gsm" } });
    const ds = await datasets.get("acme", "gsm", "1.0.0");
    // latest 로 해석된 구체 버전(1.2.0)을 역링크가 가리킨다 — "gsm@1.2.0 레시피가 이 데이터셋을 만들었다".
    expect(ds.producedBy).toEqual({ via: "recipe", id: "gsm", version: "1.2.0" });
  });
});

describe("BenchmarkService — HF 접속 실패는 자연스럽게(UpstreamError, raw 에러 노출 금지)", () => {
  it("네트워크 실패(fetch 가 throw) → UpstreamError + 사람 친화 메시지", async () => {
    const svc = new BenchmarkService({
      datasets: new InMemoryDatasetRegistry(),
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as FetchLike,
    });
    await expect(svc.searchHf("acme", "gsm8k")).rejects.toBeInstanceOf(UpstreamError);
    await expect(svc.searchHf("acme", "gsm8k")).rejects.toThrow(/접속할 수 없습니다/);
  });

  it("non-2xx(503 등) → UpstreamError(응답 오류)", async () => {
    const svc = new BenchmarkService({
      datasets: new InMemoryDatasetRegistry(),
      fetchImpl: (async () => ({ ok: false, status: 503, text: async () => "down" })) as FetchLike,
    });
    await expect(svc.hfSplits("acme", "openai/gsm8k")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("미리보기/인입의 HF 인출도 UpstreamError 로(레시피/도메인 에러는 그대로)", async () => {
    const svc = new BenchmarkService({
      datasets: new InMemoryDatasetRegistry(),
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as FetchLike,
    });
    await expect(
      svc.previewSource({ tenant: "acme", source: { kind: "huggingface", dataset: "openai/gsm8k" } }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("BenchmarkService — gated 인증은 요청자 개인 시크릿까지(셀프서비스)", () => {
  // 회귀: secretsFor 가 workspace 공유만 읽으면 멤버(admin 아님)는 자기 HF_TOKEN 을 웹에 등록해도
  // gated 인입이 불가했다. subject 가 secretsFor 로 전달되고 토큰이 HF 요청 헤더에 실려야 한다.
  function capture() {
    const seen: Array<{ url: string; auth?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, ...(init?.headers?.Authorization ? { auth: init.headers.Authorization } : {}) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ rows: [{ row: HF_ROW }], num_rows_total: 1 }),
      };
    };
    return { seen, fetchImpl };
  }

  it("previewSource 가 subject 를 secretsFor 로 넘기고 HF_TOKEN 을 Authorization 으로 보낸다", async () => {
    const { seen, fetchImpl } = capture();
    const calls: Array<{ tenant: string; subject?: string }> = [];
    const service = new BenchmarkService({
      datasets: new InMemoryDatasetRegistry(),
      fetchImpl,
      secretsFor: async (tenant, subject) => {
        calls.push({ tenant, ...(subject !== undefined ? { subject } : {}) });
        return { HF_TOKEN: "hf_personal" };
      },
    });
    await service.previewSource({
      tenant: "acme",
      subject: "u-member",
      source: { kind: "huggingface", dataset: "databricks/officeqa" },
    });
    expect(calls).toEqual([{ tenant: "acme", subject: "u-member" }]);
    expect(seen[0]?.auth).toBe("Bearer hf_personal");
  });

  it("import 는 인입자(createdBy)를 subject 로 사용한다", async () => {
    const { seen, fetchImpl } = capture();
    const calls: Array<string | undefined> = [];
    const datasets = new InMemoryDatasetRegistry();
    const service = new BenchmarkService({
      datasets,
      fetchImpl,
      secretsFor: async (_tenant, subject) => {
        calls.push(subject);
        return { HF_TOKEN: "hf_personal" };
      },
    });
    await service.import({
      tenant: "acme",
      createdBy: "u-member",
      version: "1.0.0",
      spec: {
        id: "gated-bench",
        version: "1.0.0",
        category: "qa",
        source: { kind: "huggingface", dataset: "databricks/officeqa" },
        mapping: { idField: "id", taskField: "question", answerField: "answer", promptEnv: true },
      },
    });
    expect(calls).toEqual(["u-member"]);
    expect(seen[0]?.auth).toBe("Bearer hf_personal");
    expect(await datasets.get("acme", "gated-bench", "1.0.0")).toBeTruthy();
  });

  it("searchHf/hfSplits 도 subject 를 전달한다", async () => {
    const subjects: Array<string | undefined> = [];
    const fetchImpl: FetchLike = async (url) =>
      url.includes("/splits")
        ? { ok: true, status: 200, text: async () => JSON.stringify({ splits: [] }) }
        : { ok: true, status: 200, text: async () => JSON.stringify([]) };
    const service = new BenchmarkService({
      datasets: new InMemoryDatasetRegistry(),
      fetchImpl,
      secretsFor: async (_t, subject) => {
        subjects.push(subject);
        return {};
      },
    });
    await service.searchHf("acme", "officeqa", 5, "u-member");
    await service.hfSplits("acme", "databricks/officeqa", "u-member");
    expect(subjects).toEqual(["u-member", "u-member"]);
  });
});
