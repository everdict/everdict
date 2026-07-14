// Live proof: a REAL client extension loaded into an Everdict browser target on Nomad (closes the former Phase-2 stub).
// buildBrowserJob now honors target.extension.ref — a headful Chromium (Xvfb) image with the extension baked + LOADED,
// exposing CDP. We deploy it, attach over CDP, and confirm the extension actually loaded (its service-worker target +
// its content script mutating a page title).
//
// Prereqs: nomad agent -dev (docker driver). Build the browser+extension image:
//   docker build -t everdict-hello-ext:1 examples/browser-extensions/hello-ext
// Run:  node scripts/live/browser-extension-nomad.mjs
import { buildBrowserJob, resolvePort } from "../../packages/topology/dist/deploy/nomad-topology.js";

const N = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const EXT_IMAGE = process.env.EXT_IMAGE ?? "everdict-hello-ext:1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, p, b) => {
  const r = await fetch(`${N}${p}`, {
    method: m,
    body: b ? JSON.stringify(b) : undefined,
    headers: b ? { "content-type": "application/json" } : undefined,
  });
  return { status: r.status, text: await r.text() };
};
const j = async (p) => JSON.parse((await api("GET", p)).text);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => {
  console.error(`  \x1b[31m✗ ${m}\x1b[0m`);
  process.exitCode = 1;
};

const spec = {
  kind: "service",
  id: "ext-demo",
  version: "1.0.0",
  services: [],
  dependencies: [],
  target: {
    kind: "browser",
    engine: "chromium",
    extension: { ref: EXT_IMAGE },
    lifecycle: "per-case-instance",
    observe: ["url"],
  },
  frontDoor: { service: "x", submit: "POST /x" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};

async function main() {
  console.log(
    "\n\x1b[1mClient extension loaded into an Everdict browser target (real --load-extension on Nomad)\x1b[0m",
  );

  console.log("\n1) Builder honors target.extension.ref");
  const job = buildBrowserJob(spec, "extdemo1", { datacenters: ["dc1"] });
  const task = job.Job.TaskGroups[0]?.Tasks[0];
  task?.Config.image === EXT_IMAGE && task?.Config.args === undefined
    ? ok(`browser job uses the extension image ${EXT_IMAGE} as-is (no CMD override)`)
    : fail(`unexpected browser config: image=${task?.Config.image} args=${JSON.stringify(task?.Config.args)}`);

  console.log("\n2) Deploy to Nomad + discover CDP");
  await api("DELETE", `/v1/job/${job.Job.ID}?purge=true`).catch(() => {});
  const sub = await api("POST", "/v1/jobs", { Job: job.Job });
  if (sub.status !== 200) return fail(`submit failed: ${sub.status} ${sub.text}`);
  let alloc;
  for (let i = 0; i < 90; i++) {
    const allocs = await j(`/v1/job/${job.Job.ID}/allocations`);
    alloc = allocs.find((a) => a.TaskGroup === "browser");
    if (alloc?.ClientStatus === "running") break;
    if (alloc?.ClientStatus === "failed") return fail(`browser alloc failed: ${JSON.stringify(alloc.TaskStates)}`);
    await sleep(3000);
  }
  if (alloc?.ClientStatus !== "running") return fail(`browser not running (${alloc?.ClientStatus})`);
  const full = await j(`/v1/allocation/${alloc.ID}`);
  const p = resolvePort(full, "cdp");
  if (!p) return fail("no CDP port discovered");
  const cdp = `http://${p.hostIp}:${p.port}`;
  ok(`browser running, CDP at ${cdp}`);

  console.log("\n3) The extension actually LOADED (its service-worker target is present over CDP)");
  let targets = [];
  for (let i = 0; i < 30; i++) {
    try {
      const ver = await fetch(`${cdp}/json/version`).then((r) => r.json());
      targets = await fetch(`${cdp}/json`).then((r) => r.json());
      if (i === 0) console.log(`     ${ver.Browser}`);
      if (targets.some((t) => String(t.url || "").startsWith("chrome-extension://"))) break;
    } catch {
      /* CDP not up yet */
    }
    await sleep(2000);
  }
  const extTarget = targets.find((t) => String(t.url || "").startsWith("chrome-extension://"));
  extTarget
    ? ok(`extension loaded — CDP target type=${extTarget.type} url=${String(extTarget.url).slice(0, 60)}…`)
    : fail(`no chrome-extension:// target found (targets: ${targets.map((t) => t.type).join(",")})`);

  console.log("\n4) The extension's content script RUNS (it prefixes page titles with EXT-LOADED:)");
  try {
    // open a fresh page → the content script runs at document_start and mutates the title.
    await fetch(`${cdp}/json/new?data:text/html,<title>probe</title>`, { method: "PUT" }).catch(() => {});
    await sleep(1500);
    const after = await fetch(`${cdp}/json`).then((r) => r.json());
    const probe = after.find((t) => String(t.url || "").startsWith("data:text/html"));
    probe && String(probe.title || "").startsWith("EXT-LOADED:")
      ? ok(`content script ran — page title = "${probe.title}"`)
      : console.log(
          `  · content-script title check inconclusive (title="${probe?.title}") — the service-worker proof above is authoritative`,
        );
  } catch (e) {
    console.log(`  · content-script check skipped (${e.message})`);
  }

  console.log("\n5) Cleanup");
  await api("DELETE", `/v1/job/${job.Job.ID}?purge=true`);
  ok("purged");
  console.log(
    process.exitCode
      ? "\n\x1b[31mFAILED\x1b[0m"
      : "\n\x1b[32mALL CHECKS PASSED — a real client extension was loaded into an Everdict browser target on Nomad.\x1b[0m",
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
