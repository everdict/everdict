import { BadRequestError } from "@everdict/core";

// 배포 정책(기본): 실행은 반드시 "어디서 돌지"를 명시해야 한다 — 등록된 테넌트 런타임 id 또는 self-hosted 러너
// (self:<id> / self:ws[:<id>]). control-plane 호스트 in-process(LocalBackend)로의 조용한 폴백을 금지한다(격리 없는
// 호스트에서 신뢰 불가 평가 코드를 돌리지 않기 위함). 이건 API 의 고정 동작이지 옵트인 env 가 아니다 — main.ts 가
// LocalBackend 를 아예 등록하지 않고 두 서비스에 이 게이트를 항상 켠다.
//
// target = 배치 runtime id 또는 케이스 placement.target. 셋(등록 런타임 / self:<id> / self:ws)이 모두 이 문자열로
// 실린다(RuntimeDispatcher 가 그 값을 보고 라우팅). 그래서 여기선 "비어 있지 않은가"만 본다 — 값의 유효성(존재 여부)은
// 디스패치 시점에 RuntimeDispatcher/Scheduler 가 NOT_FOUND 로 처리한다. 제출 시점 fail-fast 로 조용한 local 폴백만 차단.
//
// enforce 인자는 env 토글이 아니라 배선 신호다: API(main.ts)는 항상 true(local 미등록). 서비스 단위 테스트는 mock
// dispatcher 를 직접 주입해 백엔드 개념이 없으므로 기본 false(미지정) — Dispatcher 추상을 깨지 않기 위한 것.
export function assertRuntimeTarget(enforce: boolean | undefined, target: string | undefined): void {
  if (!enforce) return; // 테스트/추상 경로 — 게이트 미적용(호출부가 dispatcher 를 직접 책임진다)
  if (target?.trim()) return;
  throw new BadRequestError(
    "BAD_REQUEST",
    {},
    "이 배포에서는 실행 런타임을 지정해야 합니다 — 등록된 런타임 id 또는 self:<러너>(self:ws). local(컨트롤플레인 호스트 in-process) 폴백은 비활성화되어 있습니다.",
  );
}
