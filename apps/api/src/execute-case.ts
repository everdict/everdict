import type { Dispatcher } from "@assay/backends";
import { type AgentJob, type CaseResult, type RegistryAuth, imageUsesRegistryHost } from "@assay/core";
import type { TraceSource, TraceSourceConfig } from "@assay/trace";
import { collectDeferredTrace } from "./collect-trace.js";

// 실행(Execution) 관심사 — 케이스 하나를 돌려 결과를 만드는 순수 유닛. run/scorecard 가 공유한다.
// "뒤(정산·오프로드·알림)"는 신경 쓰지 않는다 — 그건 오케스트레이션의 몫(RunService/배치가 결과를 받아 settle/notify).
// 잡이 수집을 미룬 결과(traceRef)는 여기서 완성한다(플랫폼 pull+미뤄진 관측물 채점) — "완전한 CaseResult 반환"
// 계약을 지켜 정산(costOf)·judge 가 수집된 트레이스를 보게. docs/architecture/streaming-case-pipeline.md D4
// 두 서비스의 Deps 가 이 형태의 구조적 상위집합이라 각 서비스는 `this.deps` 를 그대로 넘길 수 있다.
// docs/architecture/execution-scoring-orchestration.md
export interface ExecuteCaseDeps {
  dispatcher: Dispatcher;
  // 잡 밖 트레이스 수집(collect="control-plane")용 소스 팩토리(@assay/trace). 미설정이면 수집 불가를 가시화.
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource;
  // traceRef.authSecret(이름) 재해석용 테넌트 SecretStore(복호화 값) — 수집 pull 의 Authorization 헤더.
  secretsFor?: (tenant: string) => Promise<Record<string, string>>;
  sleep?: (ms: number) => Promise<void>; // 수집 재시도 백오프(테스트 주입, 기본 setTimeout)
  // 비공개 repo 시드용 토큰 resolve(우선) — 워크스페이스 소유 GitHub App. 케이스 git URL 의 owner 가 워크스페이스
  // installation account 와 매칭되면 그 App 으로 repo-스코프 installation 토큰을 발급(제출자 개인 로그인 무관, 팀 공용).
  installationTokenFor?: (workspace: string, gitUrl: string) => Promise<string | undefined>;
  // (레거시) 개인 연결 — evalCase.env.source.connectionId → 외부 계정 연결 토큰(개인 소유, owner 로 resolve). S6 에서 제거.
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
  // 워크스페이스 이미지 레지스트리(복수) pull 자격증명(best-effort) — 잡 이미지의 host 와 매칭되는 레지스트리가
  // 있으면 그 자격증명을 job.registryAuth(transient)로 attach 한다. docs/architecture/workspace-image-registry.md
  registryAuthsFor?: (workspace: string) => Promise<RegistryAuth[]>;
}

// 이 잡이 pull 할 수 있는 모든 이미지 참조 — 케이스 이미지 + service 하니스 서비스 이미지(+per-dispatch 핀 override).
export function jobImages(job: AgentJob): string[] {
  const images: string[] = [];
  if (job.evalCase.image) images.push(job.evalCase.image);
  const spec = job.harnessSpec;
  if (spec?.kind === "service") for (const s of spec.services) images.push(job.imagePins?.[s.name] ?? s.image);
  return images;
}

// 잡 이미지 중 워크스페이스 레지스트리(복수) 것이 있으면 그 레지스트리의 pull 자격증명을 attach
// (repoToken 과 동일 규율 — 비영속 transient). 첫 host 매칭 1건만 — AgentJob.registryAuth 는 단수 계약이라
// 서로 다른 두 BYO 레지스트리 이미지를 한 잡에 섞으면 첫 매칭만 인증된다(문서화된 한계).
async function resolveRegistryAuth(deps: ExecuteCaseDeps, job: AgentJob): Promise<RegistryAuth | undefined> {
  if (!deps.registryAuthsFor || !job.tenant) return undefined;
  const auths = await deps.registryAuthsFor(job.tenant).catch(() => [] as RegistryAuth[]);
  const images = jobImages(job);
  return auths.find((auth) => images.some((image) => imageUsesRegistryHost(image, auth.host)));
}

// 케이스 repo 시드가 비공개(git)면 토큰을 resolve. 워크스페이스 GitHub App(installation) 을 먼저 시도하고
// (매칭 installation 없으면) 레거시 개인 연결(connectionId)로 폴백. public/비-repo/미설정이면 undefined.
// 모듈 내부 헬퍼(executeCase 전용) — 외부 노출 안 함.
async function resolveRepoToken(deps: ExecuteCaseDeps, owner: string, job: AgentJob): Promise<string | undefined> {
  const env = job.evalCase.env;
  if (env.kind !== "repo") return undefined;
  const src = env.source;
  if (!("git" in src)) return undefined;
  // 1) 워크스페이스 소유 GitHub App — git URL owner 가 워크스페이스 installation 과 매칭되면 그 App 토큰(우선).
  if (deps.installationTokenFor && job.tenant) {
    const t = await deps.installationTokenFor(job.tenant, src.git).catch(() => undefined);
    if (t) return t;
  }
  // 2) (레거시) 개인 연결 — connectionId 를 제출자(owner) 소유로 resolve. S6 에서 제거.
  if (deps.repoTokenFor && src.connectionId) return deps.repoTokenFor(owner, src.connectionId).catch(() => undefined);
  return undefined;
}

// command 하니스가 선언한 실행 이미지(spec.image — CI 재핀 `pins.image` 가 착지하는 필드)를, 케이스가 이미지를
// 지정하지 않았을 때 케이스 실행 컨테이너로 승격한다(evalCase.image ??= harnessSpec.image). 케이스가 명시하면
// 케이스가 우선 — 데이터셋은 하니스-무관을 유지한다. 이 승격이 없으면 command 하니스의 image 핀이 실행에 전혀
// 닿지 않는다: 모든 백엔드가 evalCase.image 로 컨테이너를 고르고(harness 폴백 없음), 셀프호스트 러너는
// job.evalCase.image 만 읽는다 → CI 이미지 재핀이 컨테이너를 바꾸지 못하는 무의미한 no-op 이 된다.
// 설계: docs/architecture/portable-harness-runtime.md.
function withHarnessImage(job: AgentJob): AgentJob {
  const spec = job.harnessSpec;
  if (!spec || spec.kind !== "command" || !spec.image || job.evalCase.image) return job;
  return { ...job, evalCase: { ...job.evalCase, image: spec.image } };
}

// 순수 실행: (하니스 이미지 승격 →) 비공개 repo 토큰 resolve+attach → dispatch → (수집 완성) → CaseResult.
// budget admit/settle 은 오케(호출부)의 회계 관심사 — 여기서 하지 않는다(run 은 그냥 실행). 잡은 호출부가 미리
// enrich(tenant/harnessSpec/judge/meterUsage/submittedBy)한 채로 넘긴다.
export async function executeCase(deps: ExecuteCaseDeps, owner: string, job: AgentJob): Promise<CaseResult> {
  const normalized = withHarnessImage(job);
  const repoToken = await resolveRepoToken(deps, owner, normalized);
  const registryAuth = await resolveRegistryAuth(deps, normalized);
  const enriched: AgentJob = {
    ...normalized,
    ...(repoToken ? { repoToken } : {}),
    ...(registryAuth ? { registryAuth } : {}),
  };
  const result = await deps.dispatcher.dispatch(enriched);
  // 수집이 잡 밖으로 미뤄진 케이스(traceRef)는 여기서 완성 — 잡은 실행 종료와 함께 반납됐다(2-페이즈).
  return collectDeferredTrace(deps, enriched.tenant, enriched.evalCase, result);
}
