// Assay run-eval GitHub Action — 의존성 0 의 node20 스크립트(fetch 내장).
// PR: 제출 시점 임시 핀(pins)으로 이 빌드 이미지를 스왑해 평가(레지스트리 무변경).
// push(dev/main): POST /harnesses/:id/pins 로 durable 재핀(새 인스턴스 버전) 후 그 버전을 평가.
// 인증: api-key 입력 → 없으면 GitHub OIDC 토큰(aud=assay) 페더레이션(워크스페이스에 repo link 필요).
// 설계: docs/architecture/github-actions-trigger.md
import { appendFileSync } from "node:fs";

// GitHub 가 JS 액션 입력을 INPUT_<대문자> env 로 넘긴다(@actions/core 없이 직접 읽어 zero-dep 유지).
// GitHub 는 공백만 _ 로 바꾸고 하이픈은 보존한다 → `api-url` = INPUT_API-URL. (하이픈을 _ 로 바꾸면 못 찾음.)
// 하이픈 버전을 우선 읽고, 직접 env 주입(INPUT_API_URL) 케이스를 위해 _ 버전도 폴백으로 본다.
function input(name, fallback) {
  const up = name.toUpperCase();
  const v = process.env[`INPUT_${up}`] ?? process.env[`INPUT_${up.replaceAll("-", "_")}`];
  return v !== undefined && v !== "" ? v : fallback;
}
function requireInput(name) {
  const v = input(name);
  if (!v) throw new Error(`필수 입력 '${name}' 이 없습니다.`);
  return v;
}
function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  else console.log(md);
}

// GitHub OIDC 토큰(aud=assay) — 워크플로에 permissions: id-token: write 필요.
async function githubOidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) throw new Error("api-key 도 OIDC(id-token: write 권한)도 없습니다 — 인증 수단이 필요합니다.");
  const res = await fetch(`${url}&audience=assay`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GitHub OIDC 토큰 발급 실패: ${res.status}`);
  const body = await res.json();
  return body.value;
}

async function main() {
  const apiUrl = requireInput("api-url").replace(/\/$/, "");
  const workspace = requireInput("workspace");
  const harness = requireInput("harness");
  const dataset = requireInput("dataset");
  const images = input("images") ? JSON.parse(input("images")) : undefined;
  const judges = input("judges") ? JSON.parse(input("judges")) : undefined;
  const runtime = input("runtime");
  const timeoutMs = Number(input("timeout-minutes", "30")) * 60_000;

  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const mode = input("mode", "auto") === "auto" ? (event === "pull_request" ? "pr" : "push") : input("mode");
  const failOnRegression =
    input("fail-on-regression") !== undefined ? input("fail-on-regression") === "true" : mode === "pr"; // PR 기본 true(회귀 시 체크 실패), push 기본 false(리포트만)

  const bearer = input("api-key") ?? (await githubOidcToken());
  const headers = {
    authorization: `Bearer ${bearer}`,
    "x-assay-workspace": workspace,
    "content-type": "application/json",
  };
  const api = async (method, path, body) => {
    const res = await fetch(`${apiUrl}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json?.message ?? text}`);
    return json;
  };

  // 커밋/PR 좌표(provenance) — 서버가 origin.source 를 결정하고 이 좌표를 scorecard 에 스탬프한다.
  const sha = process.env.GITHUB_SHA ?? "";
  const origin = {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    sha,
    ref: process.env.GITHUB_REF ?? "",
    runUrl: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  };
  if (event === "pull_request" && process.env.GITHUB_REF?.startsWith("refs/pull/")) {
    const n = Number(process.env.GITHUB_REF.split("/")[2]);
    if (Number.isFinite(n)) origin.prNumber = n;
  }

  // push 모드 + images: durable 재핀 → 새 인스턴스 버전(dev 채널 전진). 멱등(같은 digest → unchanged).
  let harnessVersion = "latest";
  if (mode === "push" && images) {
    const version = input("version", `dev-${sha.slice(0, 7)}`);
    // 기본은 digest(@sha256:…) 강제 — tag 는 움직여 재현성이 깨진다. self-hosted/로컬/air-gapped 레지스트리처럼
    // digest 를 못 쓰는 환경만 allow-tags:true 로 opt-out(그 책임은 사용자).
    const allowTags = input("allow-tags") === "true";
    const repin = await api("POST", `/harnesses/${encodeURIComponent(harness)}/pins`, {
      pins: images,
      version,
      ...(allowTags ? { allowTags: true } : {}),
    });
    harnessVersion = repin.version;
    summary(
      `### Assay re-pin\n\n\`${harness}@${repin.version}\` (base \`${repin.base}\`${repin.unchanged ? ", unchanged" : ""})`,
    );
  }

  // 발사 — PR 은 임시 핀(pins), push 는 재핀된 버전.
  const submitted = await api("POST", "/scorecards", {
    dataset: { id: dataset },
    harness: {
      id: harness,
      version: harnessVersion,
      ...(mode === "pr" && images ? { pins: images } : {}),
    },
    origin,
    ...(judges ? { judges } : {}),
    ...(runtime ? { runtime } : {}),
  });
  setOutput("scorecard-id", submitted.id);
  console.log(`scorecard ${submitted.id} queued (mode=${mode}, harness=${harness}@${harnessVersion})`);

  // baseline: 명시 입력 → 없으면 같은 dataset×harness 의 최신 succeeded(이번 것 제외).
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
      throw new Error(`scorecard ${submitted.id} 가 ${timeoutMs / 60000}분 안에 끝나지 않았습니다.`);
    await new Promise((r) => setTimeout(r, 10_000));
    record = await api("GET", `/scorecards/${submitted.id}`);
  }
  setOutput("status", record.status);

  const lines = [`### Assay eval — \`${dataset}\` × \`${harness}@${record.harness.version}\``, ""];
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
    if (diff.regressions.length === 0) lines.push("- 회귀 없음 ✅");
    for (const r of diff.regressions) lines.push(`- ⚠️ ${r.caseId} · ${r.metric}: ${r.baseline} → ${r.candidate}`);
    for (const i of diff.improvements) lines.push(`- ✅ ${i.caseId} · ${i.metric}: ${i.baseline} → ${i.candidate}`);
  }
  summary(lines.join("\n"));

  if (record.status === "failed") throw new Error(`scorecard 실패: ${record.error?.message ?? "unknown"}`);
  if (failOnRegression && regressionCount > 0) throw new Error(`baseline 대비 회귀 ${regressionCount}건 — 체크 실패.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
