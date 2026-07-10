import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatasetSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { BENCHMARK_CATALOG, adapterToDataset, importBenchmark, listBenchmarks, sweBenchImage } from "./catalog.js";
import { type FetchLike, fetchHfRows } from "./sources.js";

describe("sweBenchImage (official prebuilt image naming, verified Docker Hub convention)", () => {
  it("__ in instance_id → _1776_, default arch x86_64", () => {
    expect(sweBenchImage("astropy__astropy-12907")).toBe("swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest");
    expect(sweBenchImage("django__django-11099", "arm64")).toBe(
      "swebench/sweb.eval.arm64.django_1776_django-11099:latest",
    );
  });
});

// mock fetch that mimics the HF datasets-server /rows response (no network).
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

describe("fetchHfRows (HF source connector)", () => {
  it("fetches one /rows page and flattens it into an array of row objects", async () => {
    const { f, calls } = mockHf([[{ question: "q1", answer: "a1" }]], 1);
    const rows = await fetchHfRows({ dataset: "openai/gsm8k", config: "main", split: "test", limit: 5 }, f);
    expect(rows).toEqual([{ question: "q1", answer: "a1" }]);
    expect(calls[0]).toContain("dataset=openai%2Fgsm8k");
    expect(calls[0]).toContain("config=main");
    expect(calls[0]).toContain("split=test");
  });

  it("pages 100 at a time up to limit and stops at num_rows_total", async () => {
    const page = (n: number) => Array.from({ length: n }, (_, k) => ({ i: k }));
    const { f, calls } = mockHf([page(100), page(50)], 150);
    const rows = await fetchHfRows({ dataset: "d", limit: 130 }, f);
    expect(rows).toHaveLength(130); // 100 + 30 (sliced by limit)
    expect(calls).toHaveLength(2); // two calls
  });

  it("Authorization header when token is present (gated dataset)", async () => {
    let seen: Record<string, string> | undefined;
    const f: FetchLike = async (_url, init) => {
      seen = init?.headers;
      return { ok: true, status: 200, text: async () => JSON.stringify({ rows: [], num_rows_total: 0 }) };
    };
    await fetchHfRows({ dataset: "gaia-benchmark/GAIA", token: "hf_secret", limit: 1 }, f);
    expect(seen?.Authorization).toBe("Bearer hf_secret");
  });

  it("throws with the status code on !ok", async () => {
    const f: FetchLike = async () => ({ ok: false, status: 401, text: async () => "gated" });
    await expect(fetchHfRows({ dataset: "x", limit: 1 }, f)).rejects.toThrow(/401/);
  });
});

describe("BenchmarkAdapter catalog", () => {
  it("first-party adapters are registered", () => {
    const ids = listBenchmarks()
      .map((b) => b.id)
      .sort();
    expect(ids).toEqual(["gaia", "gsm8k", "mind2web", "osworld", "swe-bench-lite", "webvoyager"]);
    expect(listBenchmarks().find((b) => b.id === "gaia")?.gated).toBe(true); // GAIA gated flag
    expect(listBenchmarks().find((b) => b.id === "osworld")?.category).toBe("desktop"); // os-use desktop
  });

  it("imports the osworld multi-task sample (examples/benchmarks) → os-use cases + verify→command grader (dual scoring)", async () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../examples/benchmarks/osworld-sample.jsonl", import.meta.url)),
      "utf8",
    );
    const ds = await importBenchmark(BENCHMARK_CATALOG.osworld, { id: "osworld-suite", version: "1.0.0" }, { text });
    expect(ds.cases.map((c) => c.id)).toEqual(["writer-note", "writer-todo", "files-folder"]);
    expect(ds.cases.every((c) => c.env.kind === "os-use")).toBe(true);
    for (const c of ds.cases) {
      expect(c.graders.map((g) => g.id).sort()).toEqual(["command", "judge"]); // VLM judge + verify (state check)
      const cmd = c.graders.find((g) => g.id === "command");
      expect(cmd?.config?.cwd).toBe("/tmp"); // os-use has no work → absolute path
      expect(String(cmd?.config?.cmd)).toContain("test"); // verify command passed through
    }
  });

  it("osworld: os-use env + a VLM judge (screenshot) with the per-row instruction baked in — desktop computer-use", async () => {
    const rows = [
      {
        id: "chrome-001",
        instruction: "Change the default search engine to Bing.",
        snapshot: "chrome",
        source: "test",
      },
      { id: "files-002", instruction: "Create a folder named reports on the Desktop.", snapshot: "os", source: "test" },
    ];
    const text = rows.map((r) => JSON.stringify(r)).join("\n");
    const ds = await importBenchmark(BENCHMARK_CATALOG.osworld, { id: "osworld-mini", version: "1.0.0" }, { text });
    expect(DatasetSchema.safeParse(ds).success).toBe(true);
    const c = ds.cases[0];
    expect(c?.id).toBe("chrome-001");
    expect(c?.env).toMatchObject({ kind: "os-use", display: ":99", screenshotPath: "/tmp/osuse.png" }); // desktop env
    expect(c?.placement).toBeUndefined(); // container routing is driven by image — no dedicated docker runtime pin
    expect(c?.image).toBe("everdict-osworld:demo"); // common desktop image (routed by docker capability)
    expect(c?.tags).toEqual(["chrome", "test"]);
    const judge = c?.graders.find((g) => g.id === "judge");
    expect(judge?.config?.useScreenshot).toBe(true);
    expect(judge?.config?.rubric).toContain("Change the default search engine to Bing."); // per-row instruction baked in
    expect(ds.cases[1]?.graders.find((g) => g.id === "judge")?.config?.rubric).toContain(
      "Create a folder named reports",
    );
  });

  it("per-benchmark scoring presets: GAIA=answer-match exact / WebVoyager=judge / SWE-bench=tests-pass", () => {
    // GAIA: quasi-exact-match → answer-match exact mode.
    const gaia = adapterToDataset(
      BENCHMARK_CATALOG.gaia,
      [{ task_id: "g1", Question: "How many?", "Final answer": "42", Level: "1" }],
      { id: "gaia-mini", version: "2023_all" },
    );
    expect(gaia.cases[0]?.graders).toEqual([{ id: "answer-match", config: { expect: "42", mode: "exact" } }]);

    // WebVoyager: model judging (judge) + steps (+ answer-match from answerField).
    const wv = adapterToDataset(
      BENCHMARK_CATALOG.webvoyager,
      [{ id: "wv0", web: "https://example.com", ques: "h1?", answer: "Example Domain", web_name: "Example" }],
      { id: "wv", version: "1.0.0" },
    );
    expect(wv.cases[0]?.graders.map((g) => g.id)).toEqual(["answer-match", "steps", "judge"]);
    expect(wv.cases[0]?.graders.find((g) => g.id === "judge")?.config?.rubric).toContain("task goal");

    // SWE-bench: repo env (git+base_commit) + swe-bench grader (test_patch + FAIL_TO_PASS/PASS_TO_PASS, graderBuilder).
    const swe = adapterToDataset(
      BENCHMARK_CATALOG["swe-bench-lite"],
      [
        {
          instance_id: "astropy__astropy-12907",
          repo: "astropy/astropy",
          base_commit: "d16bfe0",
          problem_statement: "separability_matrix bug",
          test_patch: "diff --git a/t.py b/t.py\n",
          FAIL_TO_PASS: '["astropy/modeling/tests/test_separable.py::test_x"]',
          PASS_TO_PASS: '["astropy/modeling/tests/test_separable.py::test_y"]',
          version: "4.3",
        },
      ],
      { id: "swe-mini", version: "test" },
    );
    const c = swe.cases[0];
    expect(c?.id).toBe("astropy__astropy-12907");
    // in-image repo (/testbed) — no clone. deps come from the prebuilt image (case.image).
    expect(c?.env).toEqual({ kind: "repo", source: { path: "/testbed" } });
    const sb = c?.graders.find((g) => g.id === "swe-bench");
    expect(sb?.config?.testPatch).toContain("diff --git");
    expect(sb?.config?.failToPass).toEqual(["astropy/modeling/tests/test_separable.py::test_x"]);
    expect(sb?.config?.passToPass).toEqual(["astropy/modeling/tests/test_separable.py::test_y"]);
    expect(c?.tags).toEqual(["astropy/astropy", "4.3"]);
    // seed the official SWE-bench prebuilt image (deps+repo) as the per-case image (__ → _1776_).
    expect(c?.image).toBe("swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest");
  });

  it("gsm8k: rowTransform extracts the final answer from '…#### 18' and assigns answer-match", () => {
    const rows = [{ question: "Janet's ducks…", answer: "She makes 16-3-4=9 … #### 18" }];
    const ds = adapterToDataset(BENCHMARK_CATALOG.gsm8k, rows, { id: "gsm8k-mini", version: "main" });
    expect(DatasetSchema.safeParse(ds).success).toBe(true);
    expect(ds.cases[0]?.task).toBe("Janet's ducks…");
    expect(ds.cases[0]?.graders).toEqual([{ id: "answer-match", config: { expect: "18" } }]);
    expect(ds.cases[0]?.env).toEqual({ kind: "prompt" }); // environment-less QA — not a browser-less workaround
  });

  it("mind2web: no final answer → steps scoring + site/domain tags (browser env)", () => {
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
    expect(c?.graders).toEqual([{ id: "steps" }]); // no answer → no answer-match
    expect(c?.tags).toEqual(["exploretock", "Travel", "Restaurant"]);
  });

  it("importBenchmark(HF): fetch via mock fetch → a Dataset registrable to the tenant", async () => {
    const { f } = mockHf([[{ question: "2+2?", answer: "calc #### 4" }]], 1);
    const ds = await importBenchmark(
      BENCHMARK_CATALOG.gsm8k,
      { id: "gsm8k-mini", version: "main" },
      { limit: 1, fetchImpl: f },
    );
    expect(ds.cases).toHaveLength(1);
    expect(ds.cases[0]?.graders).toEqual([{ id: "answer-match", config: { expect: "4" } }]);
  });

  it("importBenchmark(jsonl): needs opts.text when the source is jsonl", async () => {
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
