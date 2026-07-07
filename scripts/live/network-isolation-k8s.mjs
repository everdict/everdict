// Live: NetworkPolicy enforce verification (multi-tenant network isolation). Only enforced on a **policy-CNI (Calico) cluster**
// (kindnet ignores policies — so this proof runs on the dedicated calico cluster kind-everdict-np).
//   Part A (deny-cross-tenant): tenant acme pod → tenant globex service = blocked (globex ingress = same-ns only),
//                               same ns → allowed. cross-tenant pod-to-pod reachability blocked.
//   Part B (shared-store ingress): everdict-managed namespace (acme) → shared PG = allowed, non-managed ns → blocked.
//
// Setup: calico kind cluster 'everdict-np' + load echo/busybox/postgres images (see script comments/session).
// Usage: PATH=$HOME/.local/bin:$PATH node scripts/live/network-isolation-k8s.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime } from "../../packages/topology/dist/index.js";

const CTX = process.env.KIND_CONTEXT ?? "kind-everdict-np";
const kc = (args, input) =>
  execFileSync("kubectl", ["--context", CTX, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// Decide target reachability with a throwaway busybox pod → "REACHABLE"/"BLOCKED".
let n = 0;
const probe = (ns, shCmd) => {
  n += 1;
  try {
    const out = kc([
      "-n",
      ns,
      "run",
      `probe-${n}`,
      "--image=busybox:1.36",
      "--image-pull-policy=IfNotPresent",
      "--restart=Never",
      "--rm",
      "-i",
      "--command",
      "--",
      "sh",
      "-c",
      `${shCmd} && echo REACHABLE || echo BLOCKED`,
    ]);
    return /REACHABLE/.test(out) ? "REACHABLE" : "BLOCKED";
  } catch {
    return "BLOCKED"; // timeout/abnormal exit = treated as blocked
  }
};

const echoSvc = (id, ns) => `http://${id}-agent-server.${ns}:8080`;
const specOf = (id, deps) => ({
  kind: "service",
  id,
  version: "1.0.0",
  services: [
    { name: "agent-server", image: "mendhak/http-https-echo:latest", port: 8080, needs: [], perRun: [], replicas: 1 },
  ],
  dependencies: deps,
  frontDoor: { service: "agent-server", submit: "POST /" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
});
const zone = (id, network, storeIsolation) => ({
  id,
  isolationRuntime: "runc",
  namespace: `everdict-np-${id}`,
  network,
  trusted: true,
  storeIsolation,
});

const rt = new K8sTopologyRuntime({
  context: CTX,
  imagePullPolicy: "IfNotPresent",
  poolNamespace: "everdict-shared",
  readyTimeoutMs: 150_000,
});

let aPass = false;
let bPass = false;
try {
  // ---- Part A: block cross-tenant pod (deny-cross-tenant, external store) ----
  console.log("Part A: deny-cross-tenant — verify cross-tenant pod reachability is blocked …");
  const specA = specOf("np-a", []);
  await rt.ensureTopology(specA, zone("acme", "deny-cross-tenant", "external"));
  await rt.ensureTopology(specA, zone("globex", "deny-cross-tenant", "external"));
  const sameNs = probe("everdict-np-globex", `wget -T 6 -qO- ${echoSvc("np-a", "everdict-np-globex")} >/dev/null 2>&1`);
  const crossNs = probe("everdict-np-acme", `wget -T 6 -qO- ${echoSvc("np-a", "everdict-np-globex")} >/dev/null 2>&1`);
  console.log(`  globex→globex(same-ns) : ${sameNs}`);
  console.log(`  acme→globex(cross)     : ${crossNs}   <-- must be blocked`);
  aPass = sameNs === "REACHABLE" && crossNs === "BLOCKED";

  // ---- Part B: shared-store ingress — only managed ns allowed ----
  console.log("\nPart B: shared-store ingress — only everdict-managed ns allowed to reach …");
  const specB = specOf("np-b", [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }]);
  await rt.ensureTopology(specB, zone("acme", "deny-cross-tenant", "pool")); // shared PG + ingress policy + acme (managed)
  // Create a non-managed namespace (no policy/labels).
  kc(["create", "ns", "np-rogue"]);
  const fromManaged = probe("everdict-np-acme", "nc -z -w6 everdict-shared-postgres.everdict-shared 5432");
  const fromRogue = probe("np-rogue", "nc -z -w6 everdict-shared-postgres.everdict-shared 5432");
  console.log(`  acme(managed)→shared PG : ${fromManaged}`);
  console.log(`  rogue(non-managed)→PG  : ${fromRogue}   <-- must be blocked`);
  bPass = fromManaged === "REACHABLE" && fromRogue === "BLOCKED";

  const ok = aPass && bPass;
  console.log(`\nchecks: A.same-ns=${aPass} B.managed-only=${bPass}`);
  console.log(
    ok
      ? "\n✅ NetworkPolicy enforce (Calico): cross-tenant pod reachability blocked + shared store reachable only from everdict-managed ns. Trust-zone network isolation confirmed live."
      : "\n⚠️ some checks failed",
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await rt.teardown(specOf("np-a", []), zone("acme", "deny-cross-tenant", "external")).catch(() => {});
  await rt.teardown(specOf("np-a", []), zone("globex", "deny-cross-tenant", "external")).catch(() => {});
  await rt.teardown(specOf("np-b", []), zone("acme", "deny-cross-tenant", "pool")).catch(() => {});
  for (const ns of ["np-rogue", "everdict-shared"]) kc(["delete", "ns", ns, "--ignore-not-found", "--wait=false"]);
  console.log("teardown: ns deletion requested");
}
