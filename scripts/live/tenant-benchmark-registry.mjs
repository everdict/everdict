// Live e2e (SLICE 61): generalize benchmark definitions to "per-user / per-tenant" — from a catalog (code) to data the tenant registers.
// Register a BenchmarkAdapterSpec (JSON) in InMemoryBenchmarkRegistry (tenant + _shared) → isolation + _shared fallback,
// then ingest a tenant-owned Dataset via importFromSpec. The per-row SWE-bench form is also data, via graderTemplates ({field} interpolation).
import process from "node:process";
import { importFromSpec } from "../../packages/datasets/dist/index.js";
import { InMemoryBenchmarkRegistry, InMemoryDatasetRegistry } from "../../packages/registry/dist/index.js";

const reg = new InMemoryBenchmarkRegistry();
const datasets = new InMemoryDatasetRegistry();

// first-party shared recipe (_shared) — visible to every tenant.
await reg.register("_shared", {
  id: "gsm8k",
  version: "1.0.0",
  category: "qa",
  description: "GSM8K (shared)",
  source: { kind: "huggingface", dataset: "openai/gsm8k", config: "main", split: "test" },
  mapping: { idField: "id", taskField: "question", answerField: "answer" },
});
// tenant acme's private coding benchmark — per-row test_patch as a command grader (data, zero lines of code).
await reg.register("acme", {
  id: "acme-code",
  version: "1.0.0",
  category: "coding",
  source: { kind: "jsonl" },
  mapping: { idField: "iid", taskField: "problem", gitField: "_git", refField: "base" },
  graderTemplates: [
    { id: "command", config: { applyPatch: "{test_patch}", cmd: "python -m pytest -q", metric: "resolved" } },
  ],
});
// tenant globex's private QA benchmark.
await reg.register("globex", {
  id: "globex-qa",
  version: "1.0.0",
  source: { kind: "jsonl" },
  mapping: { idField: "id", taskField: "q", answerField: "a" },
});

console.log("=== per-tenant benchmark recipes (registry: tenant + _shared) ===");
console.log("acme  list:", (await reg.list("acme")).map((b) => `${b.id}(${b.owner})`).join(", "));
console.log("globex list:", (await reg.list("globex")).map((b) => `${b.id}(${b.owner})`).join(", "));

// isolation: globex cannot see acme's private recipe.
let isolated = false;
try {
  await reg.get("globex", "acme-code");
} catch {
  isolated = true;
}
console.log(
  `\nisolation: globex reads acme-code → ${isolated ? "denied (isolation OK)" : "visible (isolation failed!)"}`,
);
const sharedBoth = (await reg.get("acme", "gsm8k")).id === "gsm8k" && (await reg.get("globex", "gsm8k")).id === "gsm8k";
console.log(`_shared fallback: acme/globex both see gsm8k → ${sharedBoth}`);

// acme ingests via its own private recipe (data-only SWE-bench form) → tenant-owned Dataset.
const acmeSpec = await reg.get("acme", "acme-code");
const acmeDs = await importFromSpec(
  acmeSpec,
  { id: "acme-code", version: "1.0.0" },
  {
    text: '{"iid":"bug-1","problem":"fix add","_git":"https://github.com/acme/lib.git","base":"abc123","test_patch":"diff --git a/t.py b/t.py\\n+def test(): assert add(2,3)==5"}',
  },
);
await datasets.register("acme", acmeDs);
const c = acmeDs.cases[0];
const cmd = c.graders.find((g) => g.id === "command");
console.log(`\nacme ingest: ${acmeDs.id}@${acmeDs.version} (${acmeDs.cases.length} case)  env=${c.env.kind}`);
console.log(
  `  command grader applyPatch(interpolated)=${JSON.stringify(cmd?.config?.applyPatch)}  cmd=${JSON.stringify(cmd?.config?.cmd)}`,
);
const interpolated = String(cmd?.config?.applyPatch).includes("def test()");

// globex ingests via the _shared gsm8k recipe from real HF (registered spec → dataset).
let realHf = false;
try {
  const g = await importFromSpec(await reg.get("globex", "gsm8k"), { id: "gsm8k", version: "1.0.0" }, { limit: 2 });
  await datasets.register("globex", g);
  console.log(
    `\nglobex ingest(_shared gsm8k, real HF): ${g.cases.length} case, grader=${g.cases[0]?.graders.map((x) => x.id).join(",")}`,
  );
  realHf = g.cases.length === 2;
} catch (e) {
  console.log(`\nglobex gsm8k real HF ingest failed: ${(e.message ?? "").slice(0, 80)}`);
}

const ok = isolated && sharedBoth && interpolated && realHf;
console.log(
  ok
    ? "\n✅ SLICE 61: benchmark definitions generalized to per-tenant data — each tenant registers its own recipe (BenchmarkAdapterSpec) (isolated) + _shared fallback, and ingests a tenant-owned Dataset via importFromSpec. The per-row SWE-bench form works with no code, via graderTemplates interpolation. Catalog (code) → tenant registry (data) generalization complete."
    : "\n⚠️ Mismatch vs expected",
);
process.exit(ok ? 0 : 1);
