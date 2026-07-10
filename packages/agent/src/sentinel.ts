// re-architecture P0b: 센티널 코덱의 실체는 @everdict/contracts(job-result-wire) — 여기는 compat 셸.
// backends 가 parseResult 를 위해 엔진 콘 전체(agent)를 물던 역의존을 끊는다. P4 스윕에서 제거.
export { RESULT_SENTINEL, encodeResult, parseResult, stripSentinel } from "@everdict/contracts";
