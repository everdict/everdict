// 라이브 e2e (SLICE 61): 벤치마크 정의를 "유저별/테넌트별"로 일반화 — 카탈로그(코드)를 테넌트가 등록하는 데이터로.
// BenchmarkAdapterSpec(JSON) 을 InMemoryBenchmarkRegistry(tenant + _shared)에 등록 → 격리 + _shared 폴백,
// 그리고 importFromSpec 으로 테넌트-소유 Dataset 인입. per-row SWE-bench 형태도 graderTemplates({field} 보간)로 데이터.
import process from "node:process";
import { importFromSpec } from "../../packages/datasets/dist/index.js";
import { InMemoryBenchmarkRegistry, InMemoryDatasetRegistry } from "../../packages/registry/dist/index.js";

const reg = new InMemoryBenchmarkRegistry();
const datasets = new InMemoryDatasetRegistry();

// first-party 공유 레시피(_shared) — 모든 테넌트가 봄.
await reg.register("_shared", {
  id: "gsm8k",
  version: "1.0.0",
  category: "qa",
  description: "GSM8K (shared)",
  source: { kind: "huggingface", dataset: "openai/gsm8k", config: "main", split: "test" },
  mapping: { idField: "id", taskField: "question", answerField: "answer" },
});
// 테넌트 acme 의 private 코딩 벤치마크 — per-row test_patch 를 command grader 로(데이터, 코드 0줄).
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
// 테넌트 globex 의 private QA 벤치마크.
await reg.register("globex", {
  id: "globex-qa",
  version: "1.0.0",
  source: { kind: "jsonl" },
  mapping: { idField: "id", taskField: "q", answerField: "a" },
});

console.log("=== 테넌트별 벤치마크 레시피 (registry: tenant + _shared) ===");
console.log("acme  list:", (await reg.list("acme")).map((b) => `${b.id}(${b.owner})`).join(", "));
console.log("globex list:", (await reg.list("globex")).map((b) => `${b.id}(${b.owner})`).join(", "));

// 격리: acme 의 private 레시피는 globex 가 못 봄.
let isolated = false;
try {
  await reg.get("globex", "acme-code");
} catch {
  isolated = true;
}
console.log(`\n격리: globex 가 acme-code 조회 → ${isolated ? "거부됨(격리 OK)" : "보임(격리 실패!)"}`);
const sharedBoth = (await reg.get("acme", "gsm8k")).id === "gsm8k" && (await reg.get("globex", "gsm8k")).id === "gsm8k";
console.log(`_shared 폴백: acme/globex 둘 다 gsm8k 봄 → ${sharedBoth}`);

// acme 가 자기 private 레시피로 인입(데이터-only SWE-bench 형태) → 테넌트-소유 Dataset.
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
console.log(`\nacme 인입: ${acmeDs.id}@${acmeDs.version} (${acmeDs.cases.length} case)  env=${c.env.kind}`);
console.log(
  `  command grader applyPatch(보간)=${JSON.stringify(cmd?.config?.applyPatch)}  cmd=${JSON.stringify(cmd?.config?.cmd)}`,
);
const interpolated = String(cmd?.config?.applyPatch).includes("def test()");

// globex 가 _shared gsm8k 레시피로 실 HF 인입(등록된 spec → 데이터셋).
let realHf = false;
try {
  const g = await importFromSpec(await reg.get("globex", "gsm8k"), { id: "gsm8k", version: "1.0.0" }, { limit: 2 });
  await datasets.register("globex", g);
  console.log(
    `\nglobex 인입(_shared gsm8k, 실 HF): ${g.cases.length} case, grader=${g.cases[0]?.graders.map((x) => x.id).join(",")}`,
  );
  realHf = g.cases.length === 2;
} catch (e) {
  console.log(`\nglobex gsm8k 실 HF 인입 실패: ${(e.message ?? "").slice(0, 80)}`);
}

const ok = isolated && sharedBoth && interpolated && realHf;
console.log(
  ok
    ? "\n✅ SLICE 61: 벤치마크 정의가 테넌트별 데이터로 일반화 — 각 테넌트가 자기 레시피(BenchmarkAdapterSpec) 등록(격리) + _shared 폴백, importFromSpec 으로 테넌트-소유 Dataset 인입. per-row SWE-bench 형태도 graderTemplates 보간으로 코드 없이. 카탈로그(코드)→테넌트 레지스트리(데이터) 일반화 완료."
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
