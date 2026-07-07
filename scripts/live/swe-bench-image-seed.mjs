// 라이브 e2e (SLICE 63): 공식 SWE-bench prebuilt 이미지(deps+repo 동봉)를 per-case env.image 로 시드 → 백엔드가 사용.
//   1) 실 SWE-bench_Lite 행 인입 → case.image = swebench/sweb.eval.x86_64.<instance __→_1776_>:latest
//   2) 그 이미지가 Docker Hub 에 실제 발행돼 있는지(HTTP 200) — 시드가 진짜 이미지를 가리킴
//   3) buildNomadJob 이 case.image 를 per-case 컨테이너 이미지로 사용(기본 에이전트 이미지 대신)
// (이미지 pull/run 은 수 GB 라 여기선 안 함 — 명명/존재/배선까지 검증.)
import process from "node:process";
import { buildNomadJob } from "../../packages/backends/dist/index.js";
import { getBenchmark, importBenchmark, sweBenchImage } from "../../packages/datasets/dist/index.js";

const ds = await importBenchmark(getBenchmark("swe-bench-lite"), { id: "swe-lite", version: "test" }, { limit: 1 });
const c = ds.cases[0];
console.log("=== SWE-bench prebuilt 이미지 시드 ===");
console.log(`instance: ${c.id}`);
console.log(`case.image: ${c.image}`);
const expected = sweBenchImage(c.id);
const nameOk = c.image === expected;
console.log(`명명 규칙 일치(__→_1776_): ${nameOk}`);

// Docker Hub 에 실제 발행됐는지 확인.
const repo = String(c.image)
  .replace(/^swebench\//, "swebench/")
  .replace(/:latest$/, "");
const tagsUrl = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=5`;
let published = false;
let tags = [];
try {
  const res = await fetch(tagsUrl);
  if (res.ok) {
    const body = await res.json();
    tags = (body.results ?? []).map((t) => t.name);
    published = tags.length > 0;
  }
} catch (e) {
  console.log(`docker hub 조회 실패: ${(e.message ?? "").slice(0, 80)}`);
}
console.log(`Docker Hub 발행됨: ${published}  tags=${JSON.stringify(tags)}`);

// 백엔드가 per-case 이미지로 사용하는지(기본 에이전트 이미지 대신).
const job = { evalCase: c, harness: { id: "swe", version: "1.0.0" }, tenant: "acme" };
const spec = buildNomadJob(job, { addr: "http://nomad:4646", image: "reg/everdict-agent:1" });
const jobImage = spec.Job.TaskGroups[0]?.Tasks[0]?.Config.image;
console.log(`\nbuildNomadJob 컨테이너 이미지: ${jobImage}`);
const usesCaseImage = jobImage === c.image;
console.log(`per-case 이미지 사용(기본 에이전트 대신): ${usesCaseImage}`);

const ok = nameOk && published && usesCaseImage;
console.log(
  ok
    ? "\n✅ SLICE 63: SWE-bench 어댑터가 공식 prebuilt 이미지(deps+repo 동봉)를 per-case env.image 로 시드 → Docker Hub 실존 확인 → 백엔드(Nomad/K8s)가 case.image 를 per-case 컨테이너로 사용. 의존성 프로비저닝이 '데이터(이미지명)'로 해결됨. (full run 은 에이전트-인-이미지/별도 env 컨테이너가 남은 인프라.)"
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
