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
  type LucideIcon,
  MessageSquare,
  Monitor,
  Scale,
  Timer,
} from 'lucide-react'

// eval 케이스의 env(kind)/grader(id) 를 사람이 읽는 한글 라벨 + 아이콘 + 설명(툴팁)으로. 잡 jargon 을
// 의미로 — env=에이전트가 조작하는 세계, grader=채점 방식. 데이터셋 상세/스코어카드 등에서 공통 사용.

type Meta = { label: string; Icon: LucideIcon; hint: string }

const ENV: Record<string, Meta> = {
  prompt: { label: '프롬프트', Icon: MessageSquare, hint: '환경 없이 텍스트로만 응답하는 케이스' },
  repo: { label: '리포지토리', Icon: FolderGit2, hint: '코드 작업공간(리포)에서 파일을 다루는 케이스' },
  browser: { label: '브라우저', Icon: Globe, hint: '웹 브라우저를 조작하는 케이스' },
  'os-use': { label: 'OS', Icon: Monitor, hint: '데스크톱(OS)을 조작하는 케이스' },
}

export function envMeta(kind: string): Meta {
  return ENV[kind] ?? { label: kind, Icon: Box, hint: `환경: ${kind}` }
}

const GRADER: Record<string, Meta> = {
  automated: { label: '자동', Icon: Cog, hint: '결정적 자동 검사(정답·규칙)로 채점' },
  hybrid: { label: '하이브리드', Icon: Blend, hint: '자동 검사 + LLM 심판을 섞어 채점' },
  llm_judge: { label: 'LLM 심판', Icon: Scale, hint: 'LLM 이 트레이스를 보고 채점' },
  judge: { label: 'LLM 심판', Icon: Scale, hint: 'LLM 이 트레이스를 보고 채점' },
  'tests-pass': { label: '테스트 통과', Icon: CheckCheck, hint: '테스트 명령이 통과하면 성공' },
  cost: { label: '비용', Icon: DollarSign, hint: '토큰/비용 예산으로 채점' },
  steps: { label: '스텝', Icon: Footprints, hint: '스텝 수로 채점' },
  latency: { label: '지연', Icon: Timer, hint: '지연시간으로 채점' },
}

export function graderMeta(id: string): Meta {
  return GRADER[id] ?? { label: id, Icon: ClipboardCheck, hint: `채점기: ${id}` }
}

// 환경 배지 — tint 배경 + inset ring(강조). 아이콘 + 한글 라벨, hover 로 설명.
export function EnvBadge({ kind }: { kind: string }) {
  const m = envMeta(kind)
  return (
    <span
      title={m.hint}
      className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-[510] text-secondary-foreground ring-1 ring-inset ring-border [&_svg]:size-3 [&_svg]:text-faint"
    >
      <m.Icon />
      {m.label}
    </span>
  )
}

// 채점 배지 — 옅은 muted(보조). 아이콘 + 한글 라벨, hover 로 설명.
export function GraderBadge({ id }: { id: string }) {
  const m = graderMeta(id)
  return (
    <span
      title={m.hint}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground [&_svg]:size-3"
    >
      <m.Icon />
      {m.label}
    </span>
  )
}
