#!/usr/bin/env node
// THE SOAK THAT PRODUCES THE CONTRACT STEP'S EVIDENCE (docs/architecture/scoring-plane-revisions.md).
//
// `stagePromotionReadiness` decides whether the scoring stage may become the source of truth, and it decides
// from evidence: every settled pass records whether the stage it wrote agreed, field for field, with the live
// plane it certified (`ScoringRevision.stageParity`). With no evidence it answers `observed: 0, ready: false`
// — the honest state of a migration nobody has measured, and the state this deployment is in until somebody
// runs passes on purpose.
//
// This is that somebody. It re-scores real batches against a RUNNING control plane, over its own HTTP surface,
// so every observation it produces is one a real pass wrote. It manufactures nothing: a fake observation would
// certify the promotion against evidence the promotion is not about, which is the one failure this whole
// mechanism exists to prevent.
//
// It is a live script, not a test: it needs a deployment with real batches and (for the observation to exist
// at all) a scoring stage wired. Without a stage every pass records "unobserved", and the report will say so
// rather than counting them — which is the correct outcome, and the reason this prints the delta instead of
// declaring success.
//
// Usage:
//   EVERDICT_API=http://127.0.0.1:8787 EVERDICT_TOKEN=ak_… EVERDICT_INTERNAL_TOKEN=… \
//     node scripts/live/rescore-soak.mjs [--rounds 3] [--minimum 50] [--tenant acme]
import process from "node:process";

const API = process.env.EVERDICT_API ?? "http://127.0.0.1:8787";
const TOKEN = process.env.EVERDICT_TOKEN;
const INTERNAL = process.env.EVERDICT_INTERNAL_TOKEN;
if (!TOKEN || !INTERNAL) {
  console.error(
    "EVERDICT_TOKEN (a workspace API key) and EVERDICT_INTERNAL_TOKEN are required.\n" +
      "The first submits the passes; the second reads /internal/scoring-stage-promotion.",
  );
  process.exit(2);
}
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const ROUNDS = Number(arg("rounds", "1"));
const MINIMUM = Number(arg("minimum", "50"));
const TENANT = arg("tenant", undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(new URL(path, API), {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

async function readiness() {
  const url = new URL("/internal/scoring-stage-promotion", API);
  url.searchParams.set("minimum", String(MINIMUM));
  if (TENANT) url.searchParams.set("tenant", TENANT);
  const res = await fetch(url, { headers: { "x-internal-token": INTERNAL } });
  if (!res.ok) throw new Error(`readiness → ${res.status} ${await res.text()}`);
  return res.json();
}

const before = await readiness();
console.log(
  `▶ before: observed ${before.observed}/${MINIMUM} · safe ${before.safe} · unobserved ${before.unobserved} · incomplete ${before.incomplete} · ready ${before.ready}`,
);

// Only SUCCEEDED batches with judges: a pass re-judges an existing plane, so a batch with no judgment to
// re-take is not evidence about the stage — it is a no-op the report would count as nothing anyway.
const listed = await api("/scorecards?limit=100");
const candidates = (listed.items ?? listed ?? []).filter((s) => s.status === "succeeded");
if (candidates.length === 0) {
  console.log("✖ no succeeded batches to re-score — the soak needs a workspace with evaluation history.");
  process.exit(1);
}
console.log(`▶ ${candidates.length} candidate batches, ${ROUNDS} round(s)`);

let started = 0;
let refused = 0;
for (let round = 0; round < ROUNDS; round++) {
  for (const batch of candidates) {
    try {
      // The judges the batch was PINNED to — re-scoring with whatever `latest` resolves to now would change
      // the verdict rather than re-take it, and the observation would be about a different question.
      const judges = (batch.orchestration?.judges ?? []).map((j) => ({ id: j.id, version: j.version }));
      if (judges.length === 0) continue;
      await api(`/groups/${batch.id}/score`, { method: "POST", body: JSON.stringify({ judges }) });
      started++;
    } catch (err) {
      // A batch already under a live pass refuses (the claim is a CAS) — that is the fence working, not a
      // failure of the soak. Counted and named rather than retried into a thundering herd.
      refused++;
      if (process.env.EVERDICT_SOAK_VERBOSE) console.error(`  · ${batch.id}: ${err.message}`);
    }
    await sleep(250);
  }
  console.log(`  round ${round + 1}: ${started} started, ${refused} refused`);
}

// Passes settle asynchronously; poll the report rather than sleeping a guessed interval.
let after = before;
for (let i = 0; i < 60; i++) {
  await sleep(5_000);
  after = await readiness();
  if (after.observed > before.observed) break;
}

console.log(
  `▶ after:  observed ${after.observed}/${MINIMUM} · safe ${after.safe} · unobserved ${after.unobserved} · incomplete ${after.incomplete} · ready ${after.ready}`,
);
const gained = after.observed - before.observed;
if (gained === 0)
  console.log(
    "⚠ no new observations. Either the passes have not settled yet, or no scoring STAGE is wired in this\n" +
      "  deployment — in which case every pass records 'unobserved' and the report is right to count none.",
  );
else console.log(`✓ ${gained} new observation(s); ${Math.max(0, MINIMUM - after.observed)} short of the minimum.`);
if (after.blockedBy.length > 0) {
  console.log(`✖ ${after.blockedBy.length} pass(es) BLOCK the promotion — named, because a decision has to be`);
  console.log("  traceable to the units that block it. It is not a scheduling question until these are explained:");
  for (const b of after.blockedBy.slice(0, 20))
    console.log(`    · ${b.scorecardId ?? "?"} ${b.passId ?? ""} — ${b.reason}`);
}
