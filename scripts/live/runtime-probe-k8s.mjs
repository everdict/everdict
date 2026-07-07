// Live e2e: runtime connection probe — makeRuntimeProber → buildRuntimeBackend → Backend.probe(),
// run against a real kind-everdict K8s cluster. Unlike validate (schema), this checks actual reachability/auth with no job.
// Control groups: reachable (kind-everdict context) vs unreachable (wrong context / dead Nomad).
//   Run: node scripts/live/runtime-probe-k8s.mjs   (after building apps/api and packages)
import process from "node:process";
import { makeRuntimeProber } from "../../apps/api/dist/runtime-probe.js";

const probe = makeRuntimeProber({ secretsFor: async () => ({}) }); // context auth, so no secret needed

const cases = [
  {
    label: "k8s kind-everdict (context, expect reachable)",
    spec: {
      kind: "k8s",
      id: "kind-everdict",
      version: "1.0.0",
      tags: [],
      image: "everdict-agent:dev",
      context: "kind-everdict",
    },
    expect: true,
  },
  {
    label: "k8s wrong context (expect unreachable)",
    spec: {
      kind: "k8s",
      id: "bad-ctx",
      version: "1.0.0",
      tags: [],
      image: "everdict-agent:dev",
      context: "does-not-exist",
    },
    expect: false,
  },
  {
    label: "nomad localhost:4646 (dead server, expect unreachable)",
    spec: {
      kind: "nomad",
      id: "dead-nomad",
      version: "1.0.0",
      tags: [],
      image: "everdict-agent:dev",
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
console.log(`\n${pass}/${cases.length} behaved as expected`);
process.exit(pass === cases.length ? 0 : 1);
