// 준(半)-라이브 헬퍼: 실제 GitHub 조직/레포에 셀프호스티드 러너를 세우기 위한 Everdict 쪽 자동화.
// 이 스크립트는 컨트롤플레인 API 를 호출해 (1) 워크스페이스-공유 Everdict 러너를 페어링하고 (2) 내 GitHub 연결로
// GitHub Actions 러너 등록 토큰을 발급받아 (3) 빌드 서버에서 실행할 **설치 스크립트**와 워크플로 힌트를 출력한다.
// GitHub 쪽(빌드 서버에서 스크립트 실행, 워크플로 머지, Actions 발화)은 실제 인프라가 필요하므로 사람이 수행한다.
// → CI 가 도는 완전한 종단 검증은 아래 출력의 "다음 단계"를 따라 사용자가 자기 환경에서 마무리한다.
//
// 전제: 실제 배포된 컨트롤플레인 + 로그인(또는 API 키) + admin:org 를 원하면 상향 GitHub 연결.
// 인증:
//   EVERDICT_TOKEN=<Keycloak JWT 또는 ak_… API 키>   (권장, 실제 배포)
//   또는 dev 폴백: 아무것도 없으면 x-everdict-tenant:default (로컬 dev 전용 — 실 GitHub 연결은 없음)
// 입력(env):
//   EVERDICT_API_URL   컨트롤플레인 base (기본 http://localhost:8787)
//   CONNECTION_ID   쓸 GitHub 연결 id (없으면 첫 github 연결 자동 선택; 없으면 안내 후 종료)
//   REPO            "owner/name" (repo 레벨) — ORG 와 정확히 하나
//   ORG             org 이름 (org 레벨, admin:org 연결 필요) — REPO 와 정확히 하나
//   RUNNER_GROUP    (선택) org 러너 그룹
//   LABEL           (선택) Everdict 러너 표시 이름
//
// 사용: EVERDICT_TOKEN=… REPO=acme/app node scripts/live/github-self-hosted-runner.mjs
import process from "node:process";

const B = (process.env.EVERDICT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.env.EVERDICT_TOKEN;
const headers = {
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : { "x-everdict-tenant": "default" }),
};
const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.status === 204 ? null : r.json();
};

const repo = process.env.REPO;
const org = process.env.ORG;
if ((repo === undefined) === (org === undefined)) {
  console.error("✗ REPO('owner/name') 또는 ORG(org 이름) 중 정확히 하나를 지정하세요.");
  process.exit(2);
}

// 1) GitHub 연결 선택.
const { connections } = await api("/connections");
const githubConns = connections.filter((c) => c.provider === "github" || c.provider === "github-enterprise");
if (githubConns.length === 0) {
  console.error("✗ GitHub 연결이 없습니다. 먼저 계정 → 연결된 계정에서 GitHub 를 연결하세요.");
  console.error(
    "  org 레벨을 쓰려면 admin:org 상향 권한으로 연결해야 합니다(설정 › 공유 러너 › GitHub Actions 러너 › '조직').",
  );
  process.exit(1);
}
const conn = process.env.CONNECTION_ID ? githubConns.find((c) => c.id === process.env.CONNECTION_ID) : githubConns[0];
if (!conn) {
  console.error(`✗ CONNECTION_ID=${process.env.CONNECTION_ID} 인 GitHub 연결을 찾지 못했습니다.`);
  console.error(`  가능한 연결: ${githubConns.map((c) => `${c.id}(${c.accountLabel})`).join(", ")}`);
  process.exit(1);
}
if (org && !conn.scopes.includes("admin:org")) {
  console.error(
    `✗ org 레벨은 admin:org 권한 연결이 필요합니다. 이 연결(${conn.accountLabel}) scope: ${conn.scopes.join(",")}`,
  );
  console.error("  설정 › 공유 러너 › GitHub Actions 러너 › '조직' 에서 'admin:org 권한으로 다시 연결' 하세요.");
  process.exit(1);
}
console.log(`▶ GitHub 연결: ${conn.accountLabel}${conn.host ? ` (${conn.host})` : ""} [${conn.id}]`);

// 2) github-install — Everdict 워크스페이스-공유 러너 페어 + GitHub 등록 토큰 mint + 설치 스크립트 생성.
const body = {
  connectionId: conn.id,
  ...(repo ? { repository: repo } : {}),
  ...(org ? { org } : {}),
  ...(process.env.RUNNER_GROUP ? { runnerGroup: process.env.RUNNER_GROUP } : {}),
  ...(process.env.LABEL ? { label: process.env.LABEL } : {}),
};
const install = await api("/workspace/runners/github-install", { method: "POST", body: JSON.stringify(body) });
console.log(`▶ Everdict 러너 페어링: ${install.runner.id}  (runtime=${install.runtimeTarget})`);
console.log(`▶ GitHub 등록 토큰 만료: ${install.registrationExpiresAt} (단기 — 곧 실행하세요)`);

console.log("\n================= 빌드 서버에서 실행할 설치 스크립트 =================");
console.log(install.installScript);
console.log("================= 워크플로에 추가(runs-on + runtime) =================");
console.log(install.workflowHint);

console.log("\n다음 단계(사람 — 실제 GitHub 인프라):");
console.log("  1. 위 설치 스크립트를 빌드 서버에서 실행 → GitHub Actions 러너 + Everdict 러너가 함께 뜬다.");
console.log(`  2. 대상 레포 워크플로의 runs-on 을 [self-hosted, ${install.githubRunnerLabel}] 로,`);
console.log(`     run-eval 액션 runtime 입력을 ${install.runtimeTarget} 로 설정(위 힌트).`);
console.log("     (설정 › CI 연동 › 레포 연결에서 '5. 셀프호스티드 러너' 에 같은 값을 넣으면 setup-PR 이 자동 생성.)");
console.log("  3. PR/머지 → GitHub Actions 발화 → CI 가 이미지 빌드 → 나란히 붙은 Everdict 러너가 self:ws 평가 실행.");
console.log("  4. 스코어카드 origin 에 repo/sha 가 남고, 평가 결과가 PR 체크로 회신된다.");
console.log("\n✓ Everdict 쪽 준비 완료. GitHub 쪽 종단 발화는 위 단계로 사용자 환경에서 검증하세요.");
process.exit(0);
