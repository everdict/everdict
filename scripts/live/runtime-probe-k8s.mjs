// 라이브 e2e: runtime 연결 프로브 — makeRuntimeProber → buildRuntimeBackend → Backend.probe() 를
// 실제 kind-assay K8s 클러스터에 대고 돌린다. validate(스키마)와 달리 잡 없이 실제 도달성/인증을 확인.
// 대조군: 도달(kind-assay context) vs 미도달(잘못된 context / 죽은 Nomad).
//   실행: node scripts/live/runtime-probe-k8s.mjs   (apps/api·packages 빌드 후)
import process from "node:process";
import { makeRuntimeProber } from "../../apps/api/dist/runtime-probe.js";

const probe = makeRuntimeProber({ secretsFor: async () => ({}) }); // context 인증이라 시크릿 불필요

const cases = [
  {
    label: "k8s kind-assay (context, 도달 기대)",
    spec: {
      kind: "k8s",
      id: "kind-assay",
      version: "1.0.0",
      tags: [],
      image: "assay-agent:dev",
      context: "kind-assay",
    },
    expect: true,
  },
  {
    label: "k8s 잘못된 context (미도달 기대)",
    spec: {
      kind: "k8s",
      id: "bad-ctx",
      version: "1.0.0",
      tags: [],
      image: "assay-agent:dev",
      context: "does-not-exist",
    },
    expect: false,
  },
  {
    label: "nomad localhost:4646 (죽은 서버, 미도달 기대)",
    spec: {
      kind: "nomad",
      id: "dead-nomad",
      version: "1.0.0",
      tags: [],
      image: "assay-agent:dev",
      addr: "http://localhost:4646",
    },
    expect: false,
  },
];

let pass = 0;
for (const c of cases) {
  const r = await probe("acme", c.spec);
  const ok = r.reachable === c.expect;
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${c.label}`);
  console.log(`    → reachable=${r.reachable} detail="${r.detail}"`);
}
console.log(`\n${pass}/${cases.length} 기대대로 동작`);
process.exit(pass === cases.length ? 0 : 1);
