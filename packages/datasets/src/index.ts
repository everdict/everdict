// @assay/datasets — 외부 벤치마크 인제스트. 배럴(barrel): 매핑 레이어 + 소스 커넥터 + 벤치마크 어댑터/카탈로그.
// 순환 의존을 피하려 매핑 코어는 mapping.ts 로 분리(catalog 가 직접 import; index 는 재export만).
export * from "./catalog.js";
export * from "./diff.js";
export * from "./mapping.js";
export * from "./sources.js";
export * from "./spec.js";
