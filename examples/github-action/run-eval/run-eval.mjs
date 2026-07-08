// Everdict run-eval GitHub Action — a zero-dependency node20 script (fetch built in).
// PR: swap in this build's image via submit-time ephemeral pins and evaluate (registry unchanged).
// PR comment /evaluate (issue_comment): the same ephemeral-pin evaluation as PR — this event does not attach a PR check, so
// it replies with the result as a PR conversation comment (github-token input, best-effort).
// push (dev/main): durable re-pin via POST /harnesses/:id/pins (a new instance version), then evaluate that version.
// Auth: the api-key input → if absent, GitHub OIDC token (aud=everdict) federation (requires a repo link in the workspace).
// Design: docs/architecture/github-actions-trigger.md
import { appendFileSync, readFileSync } from "node:fs";
import { parseEvaluateArgs } from "./parse-evaluate-args.mjs";

// GitHub passes JS action inputs as INPUT_<UPPER> env (read directly, without @actions/core, to stay zero-dep).
// GitHub replaces only spaces with _ and preserves hyphens → `api-url` = INPUT_API-URL. (Replacing hyphens with _ would not find it.)
// Read the hyphen version first, and also fall back to the _ version for the direct env-injection (INPUT_API_URL) case.
function input(name, fallback) {
  const up = name.toUpperCase();
  const v = process.env[`INPUT_${up}`] ?? process.env[`INPUT_${up.replaceAll("-", "_")}`];
  return v !== undefined && v !== "" ? v : fallback;
}
function requireInput(name) {
  const v = input(name);
  if (!v) throw new Error(`Required input '${name}' is missing.`);
  return v;
}
function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  else console.log(md);
}

// Event payload (webhook JSON) — for issue_comment, the PR number / comment id are available only here, not from env.
function eventPayload() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// PR conversation feedback (/evaluate reply) — a failure here does not break the evaluation itself (the step summary/exit code remain).
async function githubApi(path, body) {
  const token = input("github-token");
  if (!token) return;
  try {
    await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "everdict-run-eval",
      },
      body: JSON.stringify(body),
    });
  } catch {
    // best-effort — ignore a feedback failure.
  }
}

// Whether the comment result reply already went out on the success path — prevents a double comment from the catch handler.
let conversationNotified = false;

// GitHub OIDC token (aud=everdict) — the workflow needs permissions: id-token: write.
async function githubOidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token)
    throw new Error(
      "Neither an api-key nor OIDC (id-token: write permission) is present — an auth method is required.",
    );
  const res = await fetch(`${url}&audience=everdict`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Failed to mint the GitHub OIDC token: ${res.status}`);
  const body = await res.json();
  return body.value;
}

async function main() {
  const apiUrl = requireInput("api-url").replace(/\/$/, "");
  const workspace = requireInput("workspace");
  const harness = requireInput("harness");
  const dataset = requireInput("dataset");
  // An empty images map (a link with no service slots renders images: '{}') means "no pins" — treating it as
  // set made push fires attempt an empty re-pin (400 "pins is empty", found live).
  const parsedImages = input("images") ? JSON.parse(input("images")) : undefined;
  const images = parsedImages && Object.keys(parsedImages).length > 0 ? parsedImages : undefined;
  const judges = input("judges") ? JSON.parse(input("judges")) : undefined;
  const runtime = input("runtime");
  const timeoutMs = Number(input("timeout-minutes", "30")) * 60_000;

  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const payload = eventPayload();
  // A comment trigger (/evaluate) is also a PR ephemeral pin — misjudging it as push would let one comment cause a durable re-pin (a new version).
  const mode =
    input("mode", "auto") === "auto"
      ? event === "pull_request" || event === "issue_comment"
        ? "pr"
        : "push"
      : input("mode");
  const failOnRegression =
    input("fail-on-regression") !== undefined ? input("fail-on-regression") === "true" : mode === "pr"; // PR defaults true (fail the check on regression), push defaults false (report only)

  const apiKey = input("api-key");
  let bearer = apiKey ?? (await githubOidcToken());
  const headersFor = () => ({
    authorization: `Bearer ${bearer}`,
    "x-everdict-workspace": workspace,
    "content-type": "application/json",
  });
  const api = async (method, path, body) => {
    const send = () =>
      fetch(`${apiUrl}${path}`, { method, headers: headersFor(), ...(body ? { body: JSON.stringify(body) } : {}) });
    let res = await send();
    // GitHub OIDC tokens live ~5 minutes — a long eval outlives the one fetched at start, and the poll loop then
    // dies 401 mid-wait (found live). Under federation, refresh the token once on a 401 and retry.
    if (res.status === 401 && !apiKey) {
      bearer = await githubOidcToken();
      res = await send();
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json?.message ?? text}`);
    return json;
  };

  // Commit/PR coordinates (provenance) — the server determines origin.source and stamps these coordinates onto the scorecard.
  // A comment trigger runs in the default-branch context, so GITHUB_SHA points at main — if the workflow passes the PR head it
  // checked out via the head-sha input, that is the truth of what is evaluated (provenance and the re-pin version prefix both use this value).
  const sha = input("head-sha") ?? process.env.GITHUB_SHA ?? "";
  const origin = {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    sha,
    ref: process.env.GITHUB_REF ?? "",
    runUrl: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  };
  if (event === "pull_request" && process.env.GITHUB_REF?.startsWith("refs/pull/")) {
    const n = Number(process.env.GITHUB_REF.split("/")[2]);
    if (Number.isFinite(n)) origin.prNumber = n;
  } else if (event === "issue_comment" && Number.isFinite(Number(payload.issue?.number))) {
    // A comment trigger's GITHUB_REF is the default branch — PR coordinates come from the event payload. Required for the supersede key (repo+prNumber).
    origin.prNumber = Number(payload.issue.number);
    origin.ref = `refs/pull/${origin.prNumber}/head`;
  }

  // /evaluate acknowledgment — the evaluation takes minutes, so react to the trigger comment with 👀 immediately (the conversation is the only feedback surface).
  const commentFire = event === "issue_comment";
  // /evaluate arguments (key=value after the command) tune this one fire — subset/trials/runtime/sink — without
  // touching the workflow. Malformed/unknown tokens are warnings in the reply, never failures.
  const evalArgs = commentFire ? parseEvaluateArgs(payload.comment?.body) : { overrides: {}, warnings: [] };
  if (Object.keys(evalArgs.overrides).length > 0)
    console.log(`/evaluate overrides: ${JSON.stringify(evalArgs.overrides)}`);
  for (const w of evalArgs.warnings) console.log(`/evaluate: ${w}`);
  if (commentFire && payload.comment?.id !== undefined)
    await githubApi(`/repos/${origin.repo}/issues/comments/${payload.comment.id}/reactions`, { content: "eyes" });

  // push mode + images: durable re-pin → a new instance version (advances the dev channel). Idempotent (same digest → unchanged).
  let harnessVersion = "latest";
  if (mode === "push" && images) {
    const version = input("version", `dev-${sha.slice(0, 7)}`);
    // By default require a digest (@sha256:…) — tags move and break reproducibility. Only environments that cannot use a digest,
    // like self-hosted/local/air-gapped registries, opt out with allow-tags:true (the user's responsibility).
    const allowTags = input("allow-tags") === "true";
    const repin = await api("POST", `/harnesses/${encodeURIComponent(harness)}/pins`, {
      pins: images,
      version,
      ...(allowTags ? { allowTags: true } : {}),
    });
    harnessVersion = repin.version;
    summary(
      `### Everdict re-pin\n\n\`${harness}@${repin.version}\` (base \`${repin.base}\`${repin.unchanged ? ", unchanged" : ""})`,
    );
  }

  // Launch — PR uses ephemeral pins, push uses the re-pinned version.
  const ov = evalArgs.overrides;
  const submitted = await api("POST", "/scorecards", {
    dataset: { id: dataset },
    harness: {
      id: harness,
      version: harnessVersion,
      ...(mode === "pr" && images ? { pins: images } : {}),
    },
    origin,
    ...(judges ? { judges } : {}),
    ...((ov.runtime ?? runtime) ? { runtime: ov.runtime ?? runtime } : {}),
    ...(ov.cases ? { cases: ov.cases } : {}),
    ...(ov.trials !== undefined ? { trials: ov.trials } : {}),
    ...(ov.concurrency !== undefined ? { concurrency: ov.concurrency } : {}),
    ...(ov.retries !== undefined ? { retries: ov.retries } : {}),
    ...(ov.traceSink !== undefined ? { traceSink: ov.traceSink } : {}),
  });
  setOutput("scorecard-id", submitted.id);
  console.log(`scorecard ${submitted.id} queued (mode=${mode}, harness=${harness}@${harnessVersion})`);

  // baseline: an explicit input → if absent, the latest succeeded of the same dataset×harness (excluding this one).
  let baseline = input("baseline");
  if (!baseline) {
    const list = await api("GET", "/scorecards");
    baseline = list.find(
      (r) => r.id !== submitted.id && r.status === "succeeded" && r.dataset.id === dataset && r.harness.id === harness,
    )?.id;
  }

  // poll-to-terminal.
  const deadline = Date.now() + timeoutMs;
  let record = submitted;
  while (record.status === "queued" || record.status === "running") {
    if (Date.now() > deadline)
      throw new Error(`scorecard ${submitted.id} did not finish within ${timeoutMs / 60000} minutes.`);
    await new Promise((r) => setTimeout(r, 10_000));
    record = await api("GET", `/scorecards/${submitted.id}`);
  }
  setOutput("status", record.status);

  const lines = [`### Everdict eval — \`${dataset}\` × \`${harness}@${record.harness.version}\``, ""];
  lines.push(`- scorecard: \`${record.id}\` → **${record.status}**`);
  for (const m of record.summary ?? []) {
    lines.push(
      `- ${m.metric}: mean ${m.mean.toFixed(3)}${m.passRate !== undefined ? ` · pass ${(m.passRate * 100).toFixed(0)}%` : ""}`,
    );
  }

  let regressionCount = 0;
  if (record.status === "succeeded" && baseline) {
    const diff = await api("GET", `/scorecards/diff?baseline=${baseline}&candidate=${record.id}`);
    regressionCount = diff.regressions.length;
    setOutput("regressions", String(regressionCount));
    lines.push("", `#### vs baseline \`${baseline}\``);
    if (diff.regressions.length === 0) lines.push("- No regressions ✅");
    for (const r of diff.regressions) lines.push(`- ⚠️ ${r.caseId} · ${r.metric}: ${r.baseline} → ${r.candidate}`);
    for (const i of diff.improvements) lines.push(`- ✅ ${i.caseId} · ${i.metric}: ${i.baseline} → ${i.candidate}`);
  }
  summary(lines.join("\n"));

  // A comment trigger (/evaluate) replies with the result in the conversation — for success/failure/regression alike (before the throw below).
  if (commentFire && origin.prNumber !== undefined) {
    const argLines = [];
    if (Object.keys(evalArgs.overrides).length > 0)
      argLines.push("", `applied /evaluate arguments: \`${JSON.stringify(evalArgs.overrides)}\``);
    for (const w of evalArgs.warnings) argLines.push(`- ⚠️ ${w}`);
    await githubApi(`/repos/${origin.repo}/issues/${origin.prNumber}/comments`, {
      body: [...lines, ...argLines].join("\n"),
    });
    conversationNotified = true;
  }

  if (record.status === "failed") throw new Error(`scorecard failed: ${record.error?.message ?? "unknown"}`);
  if (failOnRegression && regressionCount > 0)
    throw new Error(`${regressionCount} regression(s) vs baseline — check failed.`);
}

main().catch(async (err) => {
  console.error(err.message ?? err);
  // For a comment trigger the conversation is the only feedback surface — reply even for a failure that died before the result reply (submit/timeout, etc.).
  if ((process.env.GITHUB_EVENT_NAME ?? "") === "issue_comment" && !conversationNotified) {
    const payload = eventPayload();
    const pr = Number(payload.issue?.number);
    if (Number.isFinite(pr) && process.env.GITHUB_REPOSITORY)
      await githubApi(`/repos/${process.env.GITHUB_REPOSITORY}/issues/${pr}/comments`, {
        body: `### Everdict eval failed\n\n\`\`\`\n${err.message ?? err}\n\`\`\``,
      });
  }
  process.exit(1);
});
