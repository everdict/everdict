import { BadRequestError } from "@assay/core";
import type { RunnerMeta } from "@assay/db";
import type { CiLinkService } from "./ci-link-service.js";
import type { RunnerService } from "./runner-service.js";

// GitHub Actions 셀프호스티드 러너 자가등록(설계 doc §4) — 한 번의 admin 액션으로 빌드 서버에 **두 워커**를 세운다:
//  (1) GitHub Actions 셀프호스티드 러너(config.sh — CI 가 이미지 빌드 + Assay 호출)
//  (2) Assay 워크스페이스-공유 러너(assay runner — self:ws:<id> 잡을 lease 해 평가 실행)
// 두 워커는 같은 호스트에 나란히 산다. Assay 러너 토큰은 워크스페이스-공유 러너를 새로 페어링해 발급하고(1회 노출),
// GitHub 등록 토큰은 워크스페이스 GitHub App(administration)으로 mint(단기). BFF↔MCP 공용 코어(라우트/도구가 이걸 호출).

export interface GithubRunnerInstallInput {
  workspace: string;
  // 대상: repo 레벨(repository="owner/name") 또는 org 레벨(org="org"). 워크스페이스 GitHub App 이 그 org/repo 에 설치돼 있어야 한다. 정확히 하나.
  repository?: string; // "owner/name"
  org?: string; // org 이름 — org 레벨(모든 레포가 이 러너를 공유). admin:org 스코프 연결 필요.
  host?: string; // GHE 베이스 URL — 미지정 = github.com 우선. 같은 owner 가 여러 호스트에 설치돼 있어도 정확한 installation 으로 mint.
  label: string; // Assay 러너 표시 이름
  apiUrl: string; // 컨트롤플레인 base — `assay runner --api-url`
  githubLabels?: string[]; // GH 러너 추가 라벨(항상 self-hosted + assay-<id> 에 더해)
  capabilities?: string[]; // Assay 러너 초기 capability 라벨(러너가 붙을 때 재프로브)
  runnerGroup?: string; // org 러너 그룹(org 레벨 전용, 선택) — 그 그룹의 접근 정책이 이 러너에 적용된다
}

export interface GithubRunnerInstallResult {
  runner: RunnerMeta;
  runtimeTarget: string; // "self:ws:<id>" — 워크플로 runtime 입력에 넣는 값
  githubRunnerLabel: string; // "assay-<id>" — 워크플로 runs-on 에 넣는 라벨
  installScript: string; // 빌드 서버에서 실행할 bash(두 워커 기동)
  workflowHint: string; // 워크플로에 추가할 runs-on/runtime 스니펫
  registrationExpiresAt: string; // GitHub 등록 토큰 만료(단기)
}

export async function installGithubWorkspaceRunner(
  deps: { runnerService: RunnerService; ciLinkService: CiLinkService },
  input: GithubRunnerInstallInput,
): Promise<GithubRunnerInstallResult> {
  // 대상은 repo 또는 org 정확히 하나. repo 는 "owner/name", org 는 슬래시/공백 없는 단일 세그먼트.
  if ((input.repository === undefined) === (input.org === undefined))
    throw new BadRequestError("BAD_REQUEST", {}, "repository 또는 org 중 정확히 하나를 지정하세요.");
  if (input.repository !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(input.repository))
    throw new BadRequestError(
      "BAD_REQUEST",
      { repository: input.repository },
      "repository 는 'owner/name' 형식이어야 합니다.",
    );
  if (input.org !== undefined && !/^[^/\s]+$/.test(input.org))
    throw new BadRequestError("BAD_REQUEST", { org: input.org }, "org 는 슬래시/공백 없는 org 이름이어야 합니다.");
  const target: { repo: string } | { org: string } =
    input.org !== undefined ? { org: input.org } : { repo: input.repository as string };

  // (2) Assay 워크스페이스-공유 러너 페어링 — 평문 rnr_ 토큰은 스크립트에만 실린다(저장은 해시).
  const paired = await deps.runnerService.pairWorkspace({
    workspace: input.workspace,
    label: input.label,
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
  });
  // (1) GitHub 등록 토큰 mint — 워크스페이스 GitHub App(administration)으로. App 이 그 org/repo 에 설치돼 있어야 한다.
  const reg = await deps.ciLinkService.mintRunnerToken(input.workspace, target, input.host);

  const runnerId = paired.meta.id;
  const runtimeTarget = `self:ws:${runnerId}`;
  const githubRunnerLabel = `assay-${runnerId}`;
  const ghLabels = ["self-hosted", githubRunnerLabel, ...(input.githubLabels ?? [])];
  // config.sh --url: repo 러너는 레포 URL, org 러너는 org URL(그 org 의 모든 레포가 공유).
  const host = (reg.host ?? "https://github.com").replace(/\/$/, "");
  const repoUrl = "org" in target ? `${host}/${target.org}` : `${host}/${target.repo}`;

  const installScript = renderRunnerInstall({
    repoUrl,
    githubRegToken: reg.token,
    githubLabels: ghLabels,
    runnerName: `${input.label}-${runnerId}`,
    assayRunnerToken: paired.token,
    apiUrl: input.apiUrl.replace(/\/$/, ""),
    runtimeTarget,
    // 러너 그룹은 org 러너 전용(repo 러너엔 --runnergroup 이 무효). org 대상일 때만 전달.
    ...("org" in target && input.runnerGroup ? { runnerGroup: input.runnerGroup } : {}),
  });
  const workflowHint = renderWorkflowHint(githubRunnerLabel, runtimeTarget);

  return {
    runner: paired.meta,
    runtimeTarget,
    githubRunnerLabel,
    installScript,
    workflowHint,
    registrationExpiresAt: reg.expiresAt,
  };
}

// 빌드 서버에서 실행 — GitHub Actions 러너(config.sh) + Assay 러너를 백그라운드로 기동. 토큰은 이 스크립트에만.
function renderRunnerInstall(p: {
  repoUrl: string;
  githubRegToken: string;
  githubLabels: string[];
  runnerName: string;
  assayRunnerToken: string;
  apiUrl: string;
  runtimeTarget: string;
  runnerGroup?: string; // org 러너 그룹(org 레벨 전용, 선택) — config.sh --runnergroup
}): string {
  const rv = "2.319.1"; // actions/runner 버전 — 필요 시 갱신
  const groupFlag = p.runnerGroup ? ` \\\n  --runnergroup "${p.runnerGroup}"` : ""; // org 러너 그룹(있으면)
  return `#!/usr/bin/env bash
# Assay 가 생성한 셀프호스티드 러너 설치 스크립트 — 이 빌드 서버에 GitHub Actions 러너 + Assay 러너를 함께 세웁니다.
# 토큰이 포함되어 있으니 공유하지 마세요(GitHub 등록 토큰은 단기, Assay 토큰은 1회 노출).
set -euo pipefail

# 1) GitHub Actions 셀프호스티드 러너 (CI 빌드용)
mkdir -p actions-runner && cd actions-runner
if [ ! -f ./config.sh ]; then
  curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${rv}/actions-runner-linux-x64-${rv}.tar.gz"
  tar xzf runner.tar.gz
fi
./config.sh --unattended --replace \\
  --url "${p.repoUrl}" \\
  --token "${p.githubRegToken}" \\
  --name "${p.runnerName}" \\
  --labels "${p.githubLabels.join(",")}"${groupFlag}
nohup ./run.sh > /tmp/gh-actions-runner.log 2>&1 &
cd ..

# 2) Assay 러너 (self:ws 잡을 lease 해 평가 실행) — assay CLI 가 설치돼 있어야 합니다.
#    (미설치 시: npm i -g @assay/cli  또는 배포된 바이너리 사용)
nohup assay runner --pair "${p.assayRunnerToken}" --api-url "${p.apiUrl}" > /tmp/assay-runner.log 2>&1 &

echo "✓ GitHub Actions 러너 + Assay 러너(${p.runtimeTarget}) 기동 완료"
echo "  워크플로에서 runs-on 에 라벨을, run-eval 액션 runtime 입력에 ${p.runtimeTarget} 를 지정하세요."
`;
}

function renderWorkflowHint(githubRunnerLabel: string, runtimeTarget: string): string {
  return `jobs:
  eval:
    runs-on: [self-hosted, ${githubRunnerLabel}]   # 이 빌드 서버의 GitHub 러너에서 실행
    steps:
      # ... 이미지 빌드 ...
      - uses: assay-ai/run-eval@v1
        with:
          runtime: ${runtimeTarget}                # Assay 평가를 이 워크스페이스-공유 러너에서 실행
          # api-url / workspace / harness / dataset / images ...`;
}
