// 스코어카드 상세(서버)가 케이스 탐색기(행 목록 + 상세 다이얼로그)에 넘기는 직렬화된 케이스 뷰.
// 서버 컴포넌트가 계산을 끝내고(판정·러너 힌트 로컬라이즈·스크린샷 src 해석) 평평한 값만 넘긴다 —
// 클라이언트는 절대 재계산하지 않는다(판정은 서버가 실어 보낸 값 그대로).

export type CaseScoreView = {
  graderId: string
  metric: string
  value: number
  pass?: boolean
  label?: string
  detail?: unknown
  status?: string
  reason?: string
}

// 판정의 감사 흔적 — 어느 권위 층이, 어떤 집계로, 어떤 측정들로 결정했는가 (서버 계산 verdictBasis 그대로).
export type CaseVerdictBasisView = {
  authority: string
  aggregation: string
  deciders: { metric: string; graderId: string; pass: boolean }[]
}

export type CaseSnapshotView = {
  kind: string
  // os-use 스크린샷 — base64 data URL(개발) 또는 오프로드된 오브젝트 스토리지 URL. 렌더 가능한 것만 싣는다.
  screenshotSrc?: string
  url?: string
  domRef?: string
}

export type ScorecardCaseView = {
  // 행의 유일 키 — 트라이얼 배치에서는 같은 caseId 가 여러 행(트라이얼)으로 반복되므로 caseId 만으로는
  // 선택을 특정할 수 없다. 유일하면 caseId 그대로, 중복이면 `caseId#n` (n = 목록 내 등장 순번).
  key: string
  caseId: string
  // 같은 caseId 가 여러 번 등장할 때만 실리는 1-기반 트라이얼 순번 — 다이얼로그 헤더가 어느 트라이얼인지 밝힌다.
  trial?: number
  // 레코드 원본 results 순서 기준 0-기반 등장 순번 — 임베디드 트레이스를 요청할 때 이 행(트라이얼)의
  // 결과를 특정하는 좌표 (caseId 만으로는 트라이얼 배치에서 첫 행에 뭉개진다).
  occurrence: number
  verdict?: boolean
  verdictBasis?: CaseVerdictBasisView
  scores: CaseScoreView[]
  // 이 케이스를 실행한 자식 run — 있으면 다이얼로그의 실행 증거(궤적)는 궤적 원장에서 읽는다.
  runId?: string
  // 트레이스 싱크로 내보낸 원본/외부 트레이스 딥링크 (관측 플랫폼).
  exportUrl?: string
  sinkKind?: string
  snapshot?: CaseSnapshotView
  // 임베디드 케이스 트레이스의 error 이벤트 메시지 — 케이스가 어떻게 죽었는가.
  errors: string[]
  // self-hosted 러너 실패 힌트 — 서버가 로케일까지 끝내서 넘긴 문장 (로스터 조회는 서버의 것).
  runnerHint?: string
  // 자식 run 이 없어도(레거시·ingest) 임베디드 트레이스로 실행 증거를 열 수 있는가.
  hasTrace: boolean
  // 데이터셋 케이스 정의 — "이 케이스가 무엇이었는가". 트레이스 평가/데이터셋 조회 실패 시 없다.
  task?: string
  envKind?: string
  graderIds?: string[]
  tags?: string[]
  timeoutSec?: number
}
