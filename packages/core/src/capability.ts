import { z } from "zod";

// Capability — 런타임이 "돌릴 수 있는 것"의 단위. **kind 가 광고/매칭/강제 방식을 결정한다**:
//   functional → placement 게이트(있으면 후보, 없으면 배제)                   ← scheduler/runner-hub
//   security   → trust-zone 이 강제(라벨은 힌트일 뿐; assertHardenedIsolation) ← trust-zone.ts
//   auth       → budget(결제 주체: own-pays vs 워크스페이스)                    ← budget 레이어
// 앱 전체가 이 어휘(vocabulary) 하나를 SSOT 로 참조한다. 런타임은 자가-프로브해 광고하고,
// harness 는 kind/env/case 에서 요구를 파생 → 매칭은 kind 별 레이어가 강제한다. capability 추가 =
// 여기 한 줄 추가 → 그 kind 의 레이어가 광고/매칭/강제를 자동으로 맡는다.
// 설계: docs/architecture/self-hosted-runtime-and-runners.md.
export const CapabilityKindSchema = z.enum(["functional", "security", "auth"]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

// 어휘 SSOT — capability 이름 → { kind }. (기능 이름은 구체적으로: repo→git, os-use→computer-use.)
// security 의 `sandbox` 는 trust-zone 의 HARDENED_RUNTIMES(runsc/kata/…)/assertHardenedIsolation 과 대응 —
// 런타임 카드엔 라벨(힌트)로 뜨지만 실제 강제는 trust-zone 이 한다(label ≠ enforcement).
export const CAPABILITY_DEFS = {
  git: { kind: "functional" }, // git 으로 repo env 시드
  docker: { kind: "functional" }, // 컨테이너 이미지 실행(case.image)
  browser: { kind: "functional" }, // Playwright 브라우저 자동화(확장 아님)
  "computer-use": { kind: "functional" }, // OS GUI 제어(screenshot/click/type)
  sandbox: { kind: "security" }, // 강격리(gVisor/Kata/Firecracker/Hyper-V/KVM)
  "codex-login": { kind: "auth" }, // 머신 codex 로그인(own-pays)
  "claude-login": { kind: "auth" }, // 머신 claude 로그인(own-pays)
} as const satisfies Record<string, { kind: CapabilityKind }>;

export type CapabilityName = keyof typeof CAPABILITY_DEFS;

// 경계 검증 — 어휘 밖 문자열은 reject(임의 라벨 금지). 런타임 자가-광고/harness 요구를 파싱할 때 쓴다.
export const CapabilityNameSchema = z.enum(Object.keys(CAPABILITY_DEFS) as [CapabilityName, ...CapabilityName[]]);

export const capabilityKind = (name: CapabilityName): CapabilityKind => CAPABILITY_DEFS[name].kind;

// 주어진 kind 의 capability 이름들(어휘에서).
export function capabilitiesOfKind(kind: CapabilityKind): CapabilityName[] {
  return (Object.keys(CAPABILITY_DEFS) as CapabilityName[]).filter((n) => capabilityKind(n) === kind);
}

// 요구 capability 를 kind 로 분할 → 각 kind 를 자기 강제 레이어로 라우팅하는 추상화의 진입점.
//   functional → functionalGate(placement) · security → trust-zone · auth → budget
export function partitionCapabilities(names: readonly CapabilityName[]): Record<CapabilityKind, CapabilityName[]> {
  const out: Record<CapabilityKind, CapabilityName[]> = { functional: [], security: [], auth: [] };
  for (const n of names) out[capabilityKind(n)].push(n);
  return out;
}

// functional 배치 게이트 — 요구된 **functional** capability 가 전부 런타임 보유 집합에 있는가(순수 ⊆).
// security/auth 는 placement 가 아니라 각자 레이어(trust-zone/budget)가 처리하므로 여기선 제외한다.
export function functionalGate(required: readonly CapabilityName[], advertised: readonly string[]): boolean {
  const have = new Set(advertised);
  return required.filter((n) => capabilityKind(n) === "functional").every((n) => have.has(n));
}

// 런타임이 요구 capability 를 만족하는가 — 런타임이 capabilities 를 선언(또는 프로브)했으면 functional 부분집합을
// ⊆ 로 검사, 선언이 없으면(undefined) 미검사(true) 로 둔다(아직 capability 를 안 붙인 등록 런타임의 하위호환).
// self-hosted 러너의 배치 게이트(runner-hub)와 같은 판정을, 등록 런타임(RuntimeSpec.capabilities)에도 쓰는 진입점.
export function runtimeSatisfies(
  runtimeCapabilities: readonly string[] | undefined,
  required: readonly CapabilityName[],
): boolean {
  if (runtimeCapabilities === undefined) return true;
  return functionalGate(required, runtimeCapabilities);
}
