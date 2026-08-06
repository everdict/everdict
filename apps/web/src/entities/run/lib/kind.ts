import {
  BarChart3,
  Bot,
  Container,
  FlaskConical,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react'

import type { Run } from '../model/schema'

// The executable family of a ledger row. Readers treat an unset kind as "eval" (contract rule) — use
// `runKindOf`, never `run.kind` directly, so a legacy row gets the same treatment everywhere.
export type RunKind = NonNullable<Run['kind']>

export function runKindOf(run: Pick<Run, 'kind'>): RunKind {
  return run.kind ?? 'eval'
}

// 실행 패밀리별 표시 어휘(아이콘 + runsTable 카탈로그 키) — 실행 목록과 run 상세가 같은 이름을 쓰는
// 단일 지점. Record 완전성 덕에 컨트랙트에 패밀리가 늘면 여기 한 줄이 빠졌음을 타입체크가 먼저 말한다:
// 목록이 이름 없는 새 패밀리를 그리는 일이 없게.
export const RUN_KIND_META: Record<RunKind, { icon: LucideIcon; labelKey: string }> = {
  eval: { icon: FlaskConical, labelKey: 'kindEval' },
  agent: { icon: Bot, labelKey: 'kindAgent' },
  command: { icon: TerminalSquare, labelKey: 'kindCommand' },
  sandbox: { icon: Container, labelKey: 'kindSandbox' },
  analysis: { icon: BarChart3, labelKey: 'kindAnalysis' },
}
