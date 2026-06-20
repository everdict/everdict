import { DatasetSchema } from "@assay/core";
import { describe, expect, it } from "vitest";
import { BENCHMARK_CATALOG, adapterToDataset, importBenchmark, listBenchmarks } from "./catalog.js";
import { type FetchLike, fetchHfRows } from "./sources.js";

// HF datasets-server /rows 응답을 흉내내는 mock fetch (네트워크 없음).
function mockHf(pages: Array<Array<Record<string, unknown>>>, numRowsTotal: number): { f: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const f: FetchLike = async (url) => {
    calls.push(url);
    const rows = (pages[i++] ?? []).map((row) => ({ row }));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ rows, num_rows_total: numRowsTotal }),
    };
  };
  return { f, calls };
}

describe("fetchHfRows (HF 소스 커넥터)", () => {
  it("/rows 한 페이지를 인출해 row 객체 배열로 평탄화", async () => {
    const { f, calls } = mockHf([[{ question: "q1", answer: "a1" }]], 1);
    const rows = await fetchHfRows({ dataset: "openai/gsm8k", config: "main", split: "test", limit: 5 }, f);
    expect(rows).toEqual([{ question: "q1", answer: "a1" }]);
    expect(calls[0]).toContain("dataset=openai%2Fgsm8k");
    expect(calls[0]).toContain("config=main");
    expect(calls[0]).toContain("split=test");
  });

  it("limit 까지 100개씩 페이징하고 num_rows_total 에서 멈춤", async () => {
    const page = (n: number) => Array.from({ length: n }, (_, k) => ({ i: k }));
    const { f, calls } = mockHf([page(100), page(50)], 150);
    const rows = await fetchHfRows({ dataset: "d", limit: 130 }, f);
    expect(rows).toHaveLength(130); // 100 + 30 (limit 로 슬라이스)
    expect(calls).toHaveLength(2); // 두 번 호출
  });

  it("token 이 있으면 Authorization 헤더(gated 데이터셋)", async () => {
    let seen: Record<string, string> | undefined;
    const f: FetchLike = async (_url, init) => {
      seen = init?.headers;
      return { ok: true, status: 200, text: async () => JSON.stringify({ rows: [], num_rows_total: 0 }) };
    };
    await fetchHfRows({ dataset: "gaia-benchmark/GAIA", token: "hf_secret", limit: 1 }, f);
    expect(seen?.Authorization).toBe("Bearer hf_secret");
  });

  it("!ok 면 상태코드와 함께 throw", async () => {
    const f: FetchLike = async () => ({ ok: false, status: 401, text: async () => "gated" });
    await expect(fetchHfRows({ dataset: "x", limit: 1 }, f)).rejects.toThrow(/401/);
  });
});

describe("BenchmarkAdapter 카탈로그", () => {
  it("first-party 어댑터들이 등록돼 있음", () => {
    const ids = listBenchmarks()
      .map((b) => b.id)
      .sort();
    expect(ids).toEqual(["gaia", "gsm8k", "mind2web", "swe-bench-lite", "webvoyager"]);
    expect(listBenchmarks().find((b) => b.id === "gaia")?.gated).toBe(true); // GAIA gated 표기
  });

  it("벤치마크별 채점 프리셋: GAIA=answer-match exact / WebVoyager=judge / SWE-bench=tests-pass", () => {
    // GAIA: quasi-exact-match → answer-match exact 모드.
    const gaia = adapterToDataset(
      BENCHMARK_CATALOG.gaia,
      [{ task_id: "g1", Question: "How many?", "Final answer": "42", Level: "1" }],
      { id: "gaia-mini", version: "2023_all" },
    );
    expect(gaia.cases[0]?.graders).toEqual([{ id: "answer-match", config: { expect: "42", mode: "exact" } }]);

    // WebVoyager: 모델 판정(judge) + steps (+ answer-match from answerField).
    const wv = adapterToDataset(
      BENCHMARK_CATALOG.webvoyager,
      [{ id: "wv0", web: "https://example.com", ques: "h1?", answer: "Example Domain", web_name: "Example" }],
      { id: "wv", version: "1.0.0" },
    );
    expect(wv.cases[0]?.graders.map((g) => g.id)).toEqual(["answer-match", "steps", "judge"]);
    expect(wv.cases[0]?.graders.find((g) => g.id === "judge")?.config?.rubric).toContain("task goal");

    // SWE-bench: repo env(git+base_commit) + tests-pass(타깃 테스트만 도는 pytest).
    const swe = adapterToDataset(
      BENCHMARK_CATALOG["swe-bench-lite"],
      [
        {
          instance_id: "astropy__astropy-12907",
          repo: "astropy/astropy",
          base_commit: "d16bfe0",
          problem_statement: "separability_matrix bug",
          FAIL_TO_PASS: '["astropy/modeling/tests/test_separable.py::test_x"]',
          version: "4.3",
        },
      ],
      { id: "swe-mini", version: "test" },
    );
    const c = swe.cases[0];
    expect(c?.id).toBe("astropy__astropy-12907");
    expect(c?.env).toEqual({ kind: "repo", source: { git: "https://github.com/astropy/astropy.git", ref: "d16bfe0" } });
    const tp = c?.graders.find((g) => g.id === "tests-pass");
    expect(tp?.config?.cmd).toContain("pytest");
    expect(tp?.config?.cmd).toContain("test_separable.py::test_x");
    expect(c?.tags).toEqual(["astropy/astropy", "4.3"]);
  });

  it("gsm8k: rowTransform 가 '…#### 18' 에서 최종답을 뽑아 answer-match 부여", () => {
    const rows = [{ question: "Janet's ducks…", answer: "She makes 16-3-4=9 … #### 18" }];
    const ds = adapterToDataset(BENCHMARK_CATALOG.gsm8k, rows, { id: "gsm8k-mini", version: "main" });
    expect(DatasetSchema.safeParse(ds).success).toBe(true);
    expect(ds.cases[0]?.task).toBe("Janet's ducks…");
    expect(ds.cases[0]?.graders).toEqual([{ id: "answer-match", config: { expect: "18" } }]);
  });

  it("mind2web: 최종답 없음 → steps 채점 + 사이트/도메인 태그(browser env)", () => {
    const rows = [
      {
        annotation_id: "a7",
        confirmed_task: "Check pickup…",
        website: "exploretock",
        domain: "Travel",
        subdomain: "Restaurant",
      },
    ];
    const ds = adapterToDataset(BENCHMARK_CATALOG.mind2web, rows, { id: "m2w", version: "default" });
    const c = ds.cases[0];
    expect(c?.id).toBe("a7");
    expect(c?.task).toBe("Check pickup…");
    expect(c?.env).toEqual({ kind: "browser" });
    expect(c?.graders).toEqual([{ id: "steps" }]); // 정답 없음 → answer-match 없음
    expect(c?.tags).toEqual(["exploretock", "Travel", "Restaurant"]);
  });

  it("importBenchmark(HF): mock fetch 로 인출 → 테넌트 등록 가능한 Dataset", async () => {
    const { f } = mockHf([[{ question: "2+2?", answer: "calc #### 4" }]], 1);
    const ds = await importBenchmark(
      BENCHMARK_CATALOG.gsm8k,
      { id: "gsm8k-mini", version: "main" },
      { limit: 1, fetchImpl: f },
    );
    expect(ds.cases).toHaveLength(1);
    expect(ds.cases[0]?.graders).toEqual([{ id: "answer-match", config: { expect: "4" } }]);
  });

  it("importBenchmark(jsonl): 소스가 jsonl 이면 opts.text 필요", async () => {
    await expect(importBenchmark(BENCHMARK_CATALOG.webvoyager, { id: "wv", version: "1.0.0" }, {})).rejects.toThrow(
      /requires opts.text/,
    );
    const ds = await importBenchmark(
      BENCHMARK_CATALOG.webvoyager,
      { id: "wv", version: "1.0.0" },
      {
        text: '{"id":"ex--0","web":"https://example.com","ques":"h1?","answer":"Example Domain","web_name":"Example"}',
      },
    );
    expect(ds.cases[0]?.env).toEqual({ kind: "browser", startUrl: "https://example.com" });
    expect(ds.cases[0]?.graders.map((g) => g.id)).toEqual(["answer-match", "steps", "judge"]);
  });
});
