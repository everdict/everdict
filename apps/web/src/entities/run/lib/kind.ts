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

// The display vocabulary per execution family (an icon plus a runsTable catalog key) — the single point where the run list and the run detail
// use the same names. Record exhaustiveness means that when the contract grows a family, the typecheck says first that a line is missing here:
// so the list never draws a new family with no name.
export const RUN_KIND_META: Record<RunKind, { icon: LucideIcon; labelKey: string }> = {
  eval: { icon: FlaskConical, labelKey: 'kindEval' },
  agent: { icon: Bot, labelKey: 'kindAgent' },
  command: { icon: TerminalSquare, labelKey: 'kindCommand' },
  sandbox: { icon: Container, labelKey: 'kindSandbox' },
  analysis: { icon: BarChart3, labelKey: 'kindAnalysis' },
}
