import { z } from "zod";
import { BadRequestError } from "./errors.js";

// 테넌트의 신뢰 구역 — 멀티테넌트 격리 정책. 평가는 유저의 임의 하니스 코드를 실행하므로
// (= 임의 코드 실행) 격리는 선택이 아니라 강제다. 컨트롤플레인이 tenant→TrustZone 으로 해석한다.
export const TrustZoneSchema = z.object({
  id: z.string(), // 존 식별자 — 보통 tenant. warm 풀 키/네임스페이스 접미사로 쓰인다.
  isolationRuntime: z.string(), // docker runtime / K8s runtimeClass (예: runsc, kata, runc)
  namespace: z.string().optional(), // Nomad/K8s 네임스페이스 (논리 경계)
  network: z.enum(["deny-cross-tenant", "deny-egress", "open"]).default("deny-cross-tenant"),
  trusted: z.boolean().default(false), // first-party 하니스만 true — 격리 완화(runc) 허용
  // 공유 스토어 격리 모델: pool=공유 인프라+테넌트별 논리격리(DB/role·ACL), silo=테넌트 전용 인스턴스,
  // external=BYO 엔드포인트(storeEnv). 미지정 시 trusted→pool, untrusted→silo 로 파생.
  storeIsolation: z.enum(["pool", "silo", "external"]).optional(),
});
export type TrustZone = z.infer<typeof TrustZoneSchema>;

// 강격리로 인정하는 런타임. (사이트별로 확장 가능 — 핵심은 공유 커널 runc/none 을 배제)
const HARDENED_RUNTIMES = new Set(["runsc", "gvisor", "kata", "kata-runtime", "firecracker", "fc"]);

export function isHardenedRuntime(runtime: string): boolean {
  return HARDENED_RUNTIMES.has(runtime);
}

// untrusted 존은 강격리 런타임을 강제 — 임의 코드 실행을 공유 커널(runc/none)에서 돌리지 못하게 한다.
export function assertHardenedIsolation(zone: TrustZone): void {
  if (zone.trusted) return;
  if (!isHardenedRuntime(zone.isolationRuntime)) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { zone: zone.id, runtime: zone.isolationRuntime },
      `신뢰되지 않은 테넌트 존 '${zone.id}' 는 강격리 런타임이 필요합니다(현재 '${zone.isolationRuntime}').`,
    );
  }
}
