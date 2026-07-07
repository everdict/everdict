import {
  Blend,
  Box,
  CheckCheck,
  ClipboardCheck,
  Cog,
  DollarSign,
  FolderGit2,
  Footprints,
  Globe,
  MessageSquare,
  Monitor,
  Scale,
  Timer,
  type LucideIcon,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

// Render an eval case's env(kind)/grader(id) as a human-readable label + icon + description (tooltip). Turn raw jargon
// into meaning — env=the world the agent operates on, grader=the scoring method. Shared across dataset detail/scorecards, etc.

type Meta = { labelKey: string; Icon: LucideIcon; hintKey: string }

const ENV: Record<string, Meta> = {
  prompt: { labelKey: 'envPrompt', Icon: MessageSquare, hintKey: 'envPromptHint' },
  repo: { labelKey: 'envRepo', Icon: FolderGit2, hintKey: 'envRepoHint' },
  browser: { labelKey: 'envBrowser', Icon: Globe, hintKey: 'envBrowserHint' },
  'os-use': { labelKey: 'envOsUse', Icon: Monitor, hintKey: 'envOsUseHint' },
}

const GRADER: Record<string, Meta> = {
  automated: { labelKey: 'graderAutomated', Icon: Cog, hintKey: 'graderAutomatedHint' },
  hybrid: { labelKey: 'graderHybrid', Icon: Blend, hintKey: 'graderHybridHint' },
  llm_judge: { labelKey: 'graderLlmJudge', Icon: Scale, hintKey: 'graderLlmJudgeHint' },
  judge: { labelKey: 'graderLlmJudge', Icon: Scale, hintKey: 'graderLlmJudgeHint' },
  'tests-pass': { labelKey: 'graderTestsPass', Icon: CheckCheck, hintKey: 'graderTestsPassHint' },
  cost: { labelKey: 'graderCost', Icon: DollarSign, hintKey: 'graderCostHint' },
  steps: { labelKey: 'graderSteps', Icon: Footprints, hintKey: 'graderStepsHint' },
  latency: { labelKey: 'graderLatency', Icon: Timer, hintKey: 'graderLatencyHint' },
}

// Environment badge — tint background + inset ring (emphasis). Icon + label, description on hover.
export function EnvBadge({ kind }: { kind: string }) {
  const t = useTranslations('ui')
  const m = ENV[kind]
  const Icon = m?.Icon ?? Box
  const label = m ? t(m.labelKey) : kind
  const hint = m ? t(m.hintKey) : t('envFallbackHint', { kind })
  return (
    <span
      title={hint}
      className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-[510] text-secondary-foreground ring-1 ring-inset ring-border [&_svg]:size-3 [&_svg]:text-faint"
    >
      <Icon />
      {label}
    </span>
  )
}

// Grading badge — faint muted (secondary). Icon + label, description on hover.
export function GraderBadge({ id }: { id: string }) {
  const t = useTranslations('ui')
  const m = GRADER[id]
  const Icon = m?.Icon ?? ClipboardCheck
  const label = m ? t(m.labelKey) : id
  const hint = m ? t(m.hintKey) : t('graderFallbackHint', { id })
  return (
    <span
      title={hint}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground [&_svg]:size-3"
    >
      <Icon />
      {label}
    </span>
  )
}
