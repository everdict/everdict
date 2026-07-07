// live harness: attempt Nomad **data-plane enforce** (Consul Connect/Envoy). Connect-enabled echo servers (per tenant) +
// a probe with 2 upstreams (same/other tenant) + intention deny-default → aims for same-tenant ALLOWED, other-tenant DENIED.
//
// Status (2026-06-20): **partially verified — root cause identified.** The mesh boots fine: root nomad (bridge/iptables) +
//   self-contained Consul (gRPC/xDS) + healthy Envoy sidecar + service registration + app reachable in-netns (APP-OK). xDS is fine too —
//   the probe's envoy /clusters shows both upstreams as **healthy endpoints** (t-acme-echo, t-globex-echo). But both
//   upstreams reset. **Root cause: Nomad registers the Connect sidecar with ServiceAddress=127.0.0.1 (loopback)** → inside the probe's
//   bridge netns, 127.0.0.1 is *its own* loopback, so the echo sidecar is unreachable (NodeAddr was fixed to a routable 192.168.x
//   but Nomad still pins ServiceAddress to loopback). In short, the **address-advertisement limit** of single-node dev — cross-alloc Connect
//   needs a proper Consul client agent that advertises node-routable addresses (production Nomad+Consul satisfies this).
//   **Not a model/builder/enforce-mechanism problem** (xDS and intention decisions are both fine). The authoritative proof of Nomad network isolation is
//   the intention decision (SLICE 43). FOLLOW-UP: make sidecar addresses routable via a node-routable Consul client agent.
// Usage: PATH=$HOME/.local/bin:$PATH node scripts/live/connect-enforce-nomad.mjs (needs root nomad + alt consul-dev)
import { execFileSync } from "node:child_process";
import process from "node:process";
import { buildConnectService, consulHttp } from "../../packages/topology/dist/index.js";

const NOMAD = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const CONSUL = process.env.CONSUL_HTTP_ADDR ?? "http://127.0.0.1:18500";
const consul = consulHttp(CONSUL);
const nomad = (args) => execFileSync("nomad", args, { encoding: "utf8", env: { ...process.env, NOMAD_ADDR: NOMAD } });
const submit = async (job) => {
  const r = await fetch(`${NOMAD}/v1/jobs`, { method: "POST", body: JSON.stringify({ Job: job }) });
  if (!r.ok) throw new Error(`submit ${job.ID}: ${r.status} ${(await r.text()).slice(0, 200)}`);
};

// Connect echo server job (mesh service t-<zone>-echo + Envoy sidecar).
const echoJob = (zone) => ({
  ID: `echo-${zone}`,
  Type: "service",
  Datacenters: ["dc1"],
  TaskGroups: [
    {
      Name: "echo",
      Count: 1,
      // Connect: bridge + the service port is the literal port the app listens on (8080) — the sidecar forwards to localhost:8080 inside the netns.
      Networks: [{ Mode: "bridge" }],
      Services: [buildConnectService(`t-${zone}-echo`, "8080")],
      Tasks: [
        {
          Name: "echo",
          Driver: "docker",
          Config: { image: "mendhak/http-https-echo:latest" },
          Resources: { CPU: 200, MemoryMB: 128 },
        },
      ],
    },
  ],
});
// probe job: 2 upstreams — same-tenant (acme) echo + other-tenant (globex) echo. Reachability tested via busybox.
const probeJob = {
  ID: "probe-acme",
  Type: "service",
  Datacenters: ["dc1"],
  TaskGroups: [
    {
      Name: "probe",
      Count: 1,
      // the probe also runs a real inbound app (echo:8080) so its sidecar service is healthy → upstream xDS is delivered correctly.
      Networks: [{ Mode: "bridge" }],
      Services: [
        buildConnectService("t-probe-acme", "8080", [
          { DestinationName: "t-acme-echo", LocalBindPort: 7001 }, // same tenant
          { DestinationName: "t-globex-echo", LocalBindPort: 7002 }, // other tenant (should be blocked)
        ]),
      ],
      Tasks: [
        {
          Name: "probe",
          Driver: "docker",
          Config: { image: "mendhak/http-https-echo:latest" }, // alpine+node → has wget, listens on 8080
          Resources: { CPU: 150, MemoryMB: 128 },
        },
      ],
    },
  ],
};

const runningAlloc = async (jobId) => {
  const a = await (await fetch(`${NOMAD}/v1/job/${jobId}/allocations`)).json();
  return a.find((x) => x.ClientStatus === "running")?.ID;
};
const probeAllocId = () => runningAlloc("probe-acme");
const waitRunning = async (jobId, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const id = await runningAlloc(jobId);
    if (id) return id;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return undefined;
};
const reach = (allocId, port) => {
  try {
    const out = nomad([
      "alloc",
      "exec",
      "-task",
      "probe",
      allocId,
      "wget",
      "-T",
      "4",
      "-qO-",
      `http://localhost:${port}/`,
    ]);
    return out.length > 0 ? "ALLOWED" : "DENIED";
  } catch {
    return "DENIED"; // connection refused/timeout = blocked by the mesh
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("Nomad data-plane enforce (Consul Connect/Envoy) — verify the mesh actually blocks per intention\n");
let ok = false;
try {
  await submit(echoJob("acme"));
  await submit(echoJob("globex"));
  await submit(probeJob);
  // intentions: acme-echo allows the probe, globex-echo denies it (cross).
  await consul.applyIntention({
    Kind: "service-intentions",
    Name: "t-acme-echo",
    Sources: [
      { Name: "t-probe-acme", Action: "allow" },
      { Name: "*", Action: "deny" },
    ],
  });
  await consul.applyIntention({
    Kind: "service-intentions",
    Name: "t-globex-echo",
    Sources: [{ Name: "*", Action: "deny" }],
  });

  // wait until the echo servers + the probe's Envoy sidecar are all up (image pull + xDS sync).
  const eAcme = await waitRunning("echo-acme");
  const eGlobex = await waitRunning("echo-globex");
  const allocId = await waitRunning("probe-acme");
  if (!allocId || !eAcme || !eGlobex) throw new Error("allocs did not reach running (check Envoy/images)");
  console.log("allocs running (echo-acme, echo-globex, probe) — waiting 40s for Envoy/xDS to stabilize …");
  await sleep(40000);

  let sameTenant = "DENIED";
  let crossTenant = "ALLOWED";
  for (let i = 0; i < 12; i++) {
    sameTenant = reach(allocId, 7001);
    crossTenant = reach(allocId, 7002);
    if (sameTenant === "ALLOWED") break; // if the same tenant gets through, the mesh is ready
    await sleep(5000);
  }
  console.log(`\nsame-tenant  probe → t-acme-echo  : ${sameTenant}`);
  console.log(`cross-tenant probe → t-globex-echo: ${crossTenant}   <-- Envoy should block this`);

  ok = sameTenant === "ALLOWED" && crossTenant === "DENIED";
  console.log(`\nchecks: same-allowed=${sameTenant === "ALLOWED"} cross-denied=${crossTenant === "DENIED"}`);
  console.log(
    ok
      ? "\n✅ Nomad data-plane enforce: Consul Connect/Envoy actually applies the intention — same tenant reachable, cross tenant blocked by Envoy. K8s NetworkPolicy (Calico) ↔ Nomad Consul-Connect enforce parity complete."
      : "\n⚠️ some checks failed (mesh may not be ready — check Envoy/xDS logs)",
  );
} finally {
  if (process.env.KEEP === "1") {
    console.log("KEEP=1 → skip teardown (for inspection)");
    process.exit(ok ? 0 : 1);
  }
  for (const id of ["probe-acme", "echo-acme", "echo-globex"]) {
    try {
      nomad(["job", "stop", "-purge", id]);
    } catch {}
  }
  for (const n of ["t-acme-echo", "t-globex-echo"]) await consul.deleteIntention(n).catch(() => {});
  console.log("teardown: purge jobs + delete intentions");
}
process.exit(ok ? 0 : 1);
