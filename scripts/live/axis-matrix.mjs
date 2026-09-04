#!/usr/bin/env node
// ── EVERY AXIS OF A HARNESS IS INDEPENDENTLY EVOLVABLE — THROUGH THE REAL DOORS ───────────────────
//
// `evolution-wave.mjs` runs campaigns in parallel and every one of them moved the SAME field
// (`overrides.env.CC_SCAFFOLD`). That is one axis driven concurrently, which is not the same claim as "the
// evolution step can change the environment, the harness, the code, the tools, the prompt and the
// description". This script is that claim, checked rather than asserted.
//
// It costs no agent time on purpose. What it proves is the part a measured wave cannot: that each axis is a
// SEPARATE, NAMED lever — a candidate that moves one produces a version whose diff names that slot and no
// other, and whose digest therefore differs. Whether moving a given lever HELPS is a scorecard's job and a
// spend decision; whether the platform can tell the levers apart is this script's, and it is the half that
// makes a parallel multi-axis wave meaningful at all (a wave whose campaigns cannot be told apart by what
// they changed is a wave with one campaign in it).
//
//   node scripts/live/axis-matrix.mjs          # boots a dev control plane on CP_PORT (default 8830)
import { spawn } from "node:child_process";
import process from "node:process";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = process.env.CP_PORT ?? "8830";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { status: r.status, json: j };
};
const ok = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
  return r.json;
};
const line = (s) => console.log(`\n${"═".repeat(4)} ${s} ${"═".repeat(Math.max(0, 82 - s.length))}`);

let failures = 0;
const check = (label, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(
    `   ${pass ? "✓" : "✗"} ${label.padEnd(46)} ${pass ? "" : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`,
  );
};

// The template every candidate below varies. It declares a prompt channel (so the prompt is an axis rather
// than an env key), an image slot (the code), an env default and a param.
const TEMPLATE = {
  kind: "command",
  category: "axis-matrix",
  id: "axis",
  version: "1.0.0",
  image: "reg/axis:base",
  setup: [],
  command: "agent --task {{task}} --format {{fmt}}",
  env: { MODEL: "sonnet" },
  params: { fmt: "diff" },
  trace: { kind: "none" },
  promptChannel: { kind: "env", name: "SCAFFOLD" },
};

const instance = (version, over) => ({
  template: { id: "axis", version: "1.0.0" },
  id: "axis",
  version,
  pins: {},
  ...over,
});

// One lever each. The `expect` is the exact set of resolved-spec paths that must differ from the baseline —
// no more, because a candidate that moved two mechanisms cannot be attributed to either.
const AXES = [
  {
    axis: "prompt",
    version: "1.1.0",
    body: { overrides: { prompt: "think before you edit" } },
    expect: ["env.SCAFFOLD", "prompt"],
  },
  { axis: "harness config", version: "1.2.0", body: { overrides: { env: { MODEL: "opus" } } }, expect: ["env.MODEL"] },
  {
    axis: "harness params",
    version: "1.3.0",
    body: { overrides: { params: { fmt: "whole" } } },
    expect: ["params.fmt"],
  },
  { axis: "code (image)", version: "1.4.0", body: { pins: { image: "reg/axis:pr-42" } }, expect: ["image"] },
  {
    axis: "resources",
    version: "1.5.0",
    body: { overrides: { resources: { cpu: 2, memoryMb: 4096 } } },
    expect: ["resources"],
  },
];

console.log(`=== control plane (dev, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => void d);

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");

  line("the template, and a baseline instance");
  ok(await call("POST", "/harness-templates", TEMPLATE), "register template");
  ok(await call("POST", "/harnesses", instance("1.0.0", {})), "register baseline");
  console.log("   axis@1.0.0 — command template + baseline instance");

  line("one candidate per axis — each moves exactly one lever");
  for (const a of AXES) {
    ok(await call("POST", "/harnesses", instance(a.version, a.body)), `register ${a.axis}`);
    const diff = ok(await call("GET", `/harnesses/axis/diff?base=1.0.0&candidate=${a.version}`), `diff ${a.axis}`);
    const paths = (diff.changes ?? []).map((c) => c.path).sort();
    check(`${a.axis} → ${a.version}`, paths, [...a.expect].sort());
  }

  line("…and the refusals that keep an axis from being two spellings of one thing");
  const noChannel = { ...TEMPLATE, id: "nochan", version: "1.0.0", promptChannel: undefined };
  ok(await call("POST", "/harness-templates", noChannel), "register no-channel template");
  const orphan = await call("POST", "/harnesses", {
    template: { id: "nochan", version: "1.0.0" },
    id: "nochan",
    version: "1.1.0",
    pins: {},
    overrides: { prompt: "x" },
  });
  check("a prompt with no declared channel is refused", orphan.status, 400);
  const twice = await call(
    "POST",
    "/harnesses",
    instance("1.9.0", { overrides: { prompt: "a", env: { SCAFFOLD: "b" } } }),
  );
  check("the prompt written twice is refused", twice.status, 400);

  line("the axes are concurrently drivable — one open campaign per axis, at once");
  const issue = ok(
    await call("POST", "/issues", { title: "axis matrix", description: "one campaign per axis" }),
    "issue",
  );
  const frame = (targets, held) => ({
    subject: { type: "harness", id: "axis", baselineVersion: "1.0.0" },
    scenarios: [...targets.map((id) => ({ id })), ...held.map((id) => ({ id, heldOut: true }))],
    targets,
    judges: [],
    trialsPerCase: 8,
    budget: { maxRounds: 3 },
    significance: { fdrAlpha: 0.05, heldOutFamilySize: 3 },
  });
  // Disjoint held-out sets, because concurrent campaigns that share one spend it against two families that
  // each count only themselves (evolution-program-gap-map.md G4.11).
  const opened = await Promise.all(
    AXES.map((a, i) =>
      call("POST", "/campaigns", {
        issueId: issue.id,
        frame: frame([`t-${i}a`, `t-${i}b`], [`h-${i}a`, `h-${i}b`]),
      }),
    ),
  );
  check(
    "every axis opened a campaign",
    opened.map((r) => r.status),
    AXES.map(() => 201),
  );
  const ids = opened.map((r) => r.json.id);
  check("…and they are distinct walks", new Set(ids).size, AXES.length);

  line("each campaign hands its delegate a brief the platform authored");
  const briefs = await Promise.all(ids.map((id) => call("GET", `/campaigns/${id}/brief`)));
  check(
    "every campaign serves a brief",
    briefs.map((b) => b.status),
    AXES.map(() => 200),
  );
  const leaked = briefs.filter((b) => /"h-\d+[ab]"/.test(JSON.stringify(b.json)));
  check("no brief names a held-out scenario", leaked.length, 0);
  check(
    "every brief carries a checkable finish line",
    briefs.every((b) => (b.json.doneWhen ?? []).length > 0),
    true,
  );

  line(
    failures === 0
      ? "✅ every axis is a separate, named, concurrently drivable lever"
      : `❌ ${failures} check(s) failed`,
  );
} finally {
  cp.kill("SIGTERM");
}
process.exit(failures === 0 ? 0 : 1);
