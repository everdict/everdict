// Live e2e (SLICE 63): seed the official SWE-bench prebuilt image (deps+repo bundled) as the per-case env.image → the backend uses it.
//   1) Ingest a real SWE-bench_Lite row → case.image = swebench/sweb.eval.x86_64.<instance __→_1776_>:latest
//   2) Confirm that image is actually published on Docker Hub (HTTP 200) — the seed points at a real image
//   3) buildNomadJob uses case.image as the per-case container image (instead of the default job-runner image)
// (Image pull/run is multiple GB, so not done here — verified up to naming/existence/wiring.)
import process from "node:process";
import { buildNomadJob } from "../../packages/backends/dist/index.js";
import { getBenchmark, importBenchmark, sweBenchImage } from "../../packages/datasets/dist/index.js";

const ds = await importBenchmark(getBenchmark("swe-bench-lite"), { id: "swe-lite", version: "test" }, { limit: 1 });
const c = ds.cases[0];
console.log("=== SWE-bench prebuilt image seed ===");
console.log(`instance: ${c.id}`);
console.log(`case.image: ${c.image}`);
const expected = sweBenchImage(c.id);
const nameOk = c.image === expected;
console.log(`naming convention matches(__→_1776_): ${nameOk}`);

// Confirm it's actually published on Docker Hub.
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
  console.log(`docker hub lookup failed: ${(e.message ?? "").slice(0, 80)}`);
}
console.log(`Docker Hub published: ${published}  tags=${JSON.stringify(tags)}`);

// Confirm the backend uses it as the per-case image (instead of the default job-runner image).
const job = { evalCase: c, harness: { id: "swe", version: "1.0.0" }, tenant: "acme" };
const spec = buildNomadJob(job, { addr: "http://nomad:4646", image: "reg/everdict-job-runner:1" });
const jobImage = spec.Job.TaskGroups[0]?.Tasks[0]?.Config.image;
console.log(`\nbuildNomadJob container image: ${jobImage}`);
const usesCaseImage = jobImage === c.image;
console.log(`uses per-case image(instead of default agent): ${usesCaseImage}`);

const ok = nameOk && published && usesCaseImage;
console.log(
  ok
    ? "\n✅ SLICE 63: the SWE-bench adapter seeds the official prebuilt image (deps+repo bundled) as the per-case env.image → confirmed to exist on Docker Hub → the backend (Nomad/K8s) uses case.image as the per-case container. Dependency provisioning is resolved as 'data (image name)'. (A full run leaves agent-in-image / a separate env container as remaining infra.)"
    : "\n⚠️ Mismatch vs expected",
);
process.exit(ok ? 0 : 1);
