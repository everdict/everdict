// first-party(Everdict 저작) 빌트인의 예약 소유자 — 계약의 FIRST_PARTY_TENANT 미러(웹은 @everdict/* 에서 값을 import 하지
// 않는다 — 타입만). 빌트인은 DB 행이 아니라 코드 정의물이고 컨트롤플레인이 공개 카탈로그에 병합해 준다: 편집·삭제가 불가능
// 하고, 채택 없이도 모든 워크스페이스의 에이전트에 붙는다(끄는 것은 Settings › Agent).
export const BUILT_IN_TENANT = '_everdict'

export const isBuiltInCapability = (capability: { tenant: string }): boolean =>
  capability.tenant === BUILT_IN_TENANT
