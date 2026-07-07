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

// eval 케이스의 env(kind)/grader(id) 를 사람이 읽는 한글 라벨 + 아이콘 + 설명(툴팁)으로. 잡 jargon 을
// 의미로 — env=에이전트가 조작하는 세계, grader=채점 방식. 데이터셋 상세/스코어카드 등에서 공통 사용.

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

// 환경 배지 — tint 배경 + inset ring(강조). 아이콘 + 한글 라벨, hover 로 설명.
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

// 채점 배지 — 옅은 muted(보조). 아이콘 + 한글 라벨, hover 로 설명.
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
