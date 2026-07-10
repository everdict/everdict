// L0 재배치(re-architecture P0a, docs/architecture/rearchitecture/00-target-architecture.md):
// 계약+커널의 실체는 @everdict/contracts 로 이동했다. 이 패키지는 소비자 무파손을 위한 compat 셸 —
// P1 에서 커널 함수가 @everdict/domain 으로 분리되면 여기서 함께 재수출하고, P4 스윕에서 제거된다.
// 새 코드는 @everdict/contracts(스키마/에러) 를 직접 임포트할 것.
export * from "@everdict/contracts";
