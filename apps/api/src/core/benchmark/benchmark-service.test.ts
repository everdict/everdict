import { UpstreamError } from "@everdict/contracts";
import type { FetchLike } from "@everdict/datasets";
import { InMemoryBenchmarkRegistry, InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { BenchmarkService } from "./benchmark-service.js";

// A fake fetch mimicking the HF datasets-server /rows response (deterministic test with no network).
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

describe("BenchmarkService — source preview + inline spec import (wizard)", () => {
  it("previewSource(huggingface) returns the detected fields and sample rows before mapping", async () => {
    const { service } = svc();
    const { fields, rows } = await service.previewSource({
      tenant: "acme",
      source: { kind: "huggingface", dataset: "openai/gsm8k" },
    });
    expect(fields).toEqual(expect.arrayContaining(["id", "question", "answer"]));
    expect(rows[0]).toMatchObject({ question: "2+2?" });
  });

  it("previewSource(jsonl) parses the leading lines of text to detect fields (limit applied)", async () => {
    const { service } = svc();
    const text = '{"id":"a","ques":"hi","answer":"x"}\n{"id":"b","ques":"yo","answer":"y"}';
    const { fields, rows } = await service.previewSource({ tenant: "acme", source: { kind: "jsonl" }, text, limit: 5 });
    expect(fields).toEqual(expect.arrayContaining(["id", "ques", "answer"]));
    expect(rows).toHaveLength(2);
  });

  it("an inline spec imports as a dataset in one shot with no recipe registration (the wizard's one-action)", async () => {
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
    // Actually registered in the dataset registry — task is mapped from the question field.
    const ds = await datasets.get("acme", "my-bench", "1.0.0");
    expect(ds.cases).toHaveLength(1);
    expect(ds.cases[0]?.task).toBe("2+2?");
    // An inline-spec import also records provenance (via:spec) + etches lineage (the source HF source + canonical link).
    expect(ds.producedBy).toEqual({
      via: "spec",
      id: "my-bench",
      source: { kind: "huggingface", dataset: "openai/gsm8k", url: "https://huggingface.co/datasets/openai/gsm8k" },
    });
  });

  it("lineage: source.file (viewer-less fallback) and origin (official provenance) are etched into producedBy", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const service = new BenchmarkService({
      datasets,
      // Mimic the resolve API (direct file fetch) response: a single CSV row.
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        text: async () => "uid,question,answer\nq1,cap?,paris\n",
      })) as FetchLike,
    });
    await service.import({
      tenant: "acme",
      version: "1.0.0",
      spec: {
        id: "officeqa",
        version: "1.0.0",
        category: "qa",
        source: { kind: "huggingface", dataset: "databricks/officeqa", file: "officeqa_pro.csv" },
        origin: { homepage: "https://example.com/oqa", license: "cc-by-sa-4.0", authors: "Databricks" },
        mapping: { idField: "uid", taskField: "question", answerField: "answer", promptEnv: true },
      },
    });
    const ds = await datasets.get("acme", "officeqa", "1.0.0");
    expect(ds.producedBy).toEqual({
      via: "spec",
      id: "officeqa",
      source: {
        kind: "huggingface",
        dataset: "databricks/officeqa",
        file: "officeqa_pro.csv",
        url: "https://huggingface.co/datasets/databricks/officeqa",
      },
      origin: { homepage: "https://example.com/oqa", license: "cc-by-sa-4.0", authors: "Databricks" },
    });
  });

  it("importing from a registered recipe stamps producedBy (via:recipe, resolved version) on the dataset", async () => {
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
    // The back-link points at the concrete version (1.2.0) resolved from latest + lineage (the source HF source) is etched too.
    expect(ds.producedBy).toEqual({
      via: "recipe",
      id: "gsm",
      version: "1.2.0",
      source: { kind: "huggingface", dataset: "openai/gsm8k", url: "https://huggingface.co/datasets/openai/gsm8k" },
    });
  });
});

describe("BenchmarkService — HF connection failures surface cleanly (UpstreamError, no raw error exposed)", () => {
  it("network failure (fetch throws) → UpstreamError + human-friendly message", async () => {
    const svc = new BenchmarkService({
      datasets: new InMemoryDatasetRegistry(),
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as FetchLike,
    });
    await expect(svc.searchHf("acme", "gsm8k")).rejects.toBeInstanceOf(UpstreamError);
    await expect(svc.searchHf("acme", "gsm8k")).rejects.toThrow(/Cannot reach HuggingFace/);
  });

  it("non-2xx (503 etc.) → UpstreamError (response error)", async () => {
    const svc = new BenchmarkService({
      datasets: new InMemoryDatasetRegistry(),
      fetchImpl: (async () => ({ ok: false, status: 503, text: async () => "down" })) as FetchLike,
    });
    await expect(svc.hfSplits("acme", "openai/gsm8k")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("preview/import HF fetches also become UpstreamError (recipe/domain errors pass through)", async () => {
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

describe("BenchmarkService — gated auth reaches the requester's personal secrets (self-service)", () => {
  // Regression: if secretsFor only read workspace-shared secrets, a member (non-admin) could not do a gated
  // import even after registering their HF_TOKEN in the web. The subject must be passed to secretsFor and the token carried in the HF request header.
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

  it("previewSource passes the subject to secretsFor and sends HF_TOKEN as Authorization", async () => {
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

  it("import uses the importer (createdBy) as the subject", async () => {
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

  it("searchHf/hfSplits also pass the subject", async () => {
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
