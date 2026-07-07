import type { ScorecardRecord } from './schema'

// 케이스 합격 판정 — 권위 기준(컨트롤플레인 @everdict/suite caseVerdict 미러): ground-truth(state/tests_pass) >
// 객관(answer_match/url_matches/dom_contains) > 모델 의견(judge). judge 는 객관/ground-truth 가 없을 때만 결정한다
// (VLM judge 가 state 를 뒤집지 못함 — OSWorld 파일저장처럼).
const AUTHORITATIVE = ['state', 'tests_pass']
const OBJECTIVE = ['answer_match', 'url_matches', 'dom_contains']

type Score = { metric: string; pass?: boolean }

export function caseVerdict(scores: Score[]): boolean | undefined {
  const by = new Map(scores.map((s) => [s.metric, s]))
  for (const m of AUTHORITATIVE) {
    const s = by.get(m)
    if (s?.pass !== undefined) return s.pass
  }
  const objs = OBJECTIVE.map((m) => by.get(m)).filter((s): s is Score => s?.pass !== undefined)
  if (objs.length > 0) return objs.every((s) => s.pass)
  const judge = by.get('judge')
  if (judge?.pass !== undefined) return judge.pass
  const withPass = scores.filter((s) => s.pass !== undefined)
  return withPass.length > 0 ? withPass.every((s) => s.pass) : undefined
}

// 스코어카드를 트랙(데스크탑/웹/기타)으로 분류 — 데이터셋·하니스 id 휴리스틱.
export function trackOf(rec: ScorecardRecord): 'desktop' | 'web' | 'other' {
  const s = `${rec.dataset.id} ${rec.harness.id}`.toLowerCase()
  if (/osworld|desktop|os-use/.test(s)) return 'desktop'
  if (/webvoyager|browser|web/.test(s)) return 'web'
  return 'other'
}

// 스코어카드의 케이스 단위 통과(권위 기준). results 가 없으면 {0,0}.
export function casePass(rec: ScorecardRecord): { pass: number; total: number } {
  let pass = 0
  let total = 0
  for (const r of rec.scorecard?.results ?? []) {
    const v = caseVerdict(r.scores)
    if (v === undefined) continue
    total++
    if (v) pass++
  }
  return { pass, total }
}
