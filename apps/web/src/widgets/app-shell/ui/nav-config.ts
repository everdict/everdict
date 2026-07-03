import {
  Activity,
  BarChart3,
  Boxes,
  CalendarClock,
  Database,
  FileText,
  LayoutDashboard,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  // 워크스페이스-상대 경로 suffix(예: '' = 개요, '/scorecards'). 렌더 시 활성 워크스페이스로 prefix → /{workspace}{suffix}.
  // nav-config 는 요청 컨텍스트가 없으므로(모듈 로드 시 워크스페이스 미상) suffix 만 보관한다.
  href: string
  label: string
  icon: LucideIcon
  exact?: boolean
  keywords?: string // command 팔레트 퍼지 매칭 보조어
}

export interface NavSection {
  heading?: string
  items: NavItem[]
}

// SaaS 표면은 3개 핵심 개념으로 좁힌다: 하니스(무엇을) · 벤치마크(무엇으로) · 스코어카드(결과) + 홈(개요).
// judge/runtime/metric/model/recipe/bundle 은 엔진 부품/고급 옵션 — 벤치마크 실행에 필수가 아니라 내비에서 제외한다
// (라우트는 남아 URL 로 접근 가능; 벤치마크가 채점을 내장해 원클릭 실행이 기본).
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { href: '', label: '개요', icon: LayoutDashboard, exact: true, keywords: 'overview home 홈' },
      {
        href: '/harnesses',
        label: '하니스',
        icon: Boxes,
        keywords: 'harness 에이전트 codex claude',
      },
      {
        href: '/datasets',
        label: '벤치마크',
        icon: Database,
        keywords: 'benchmark 벤치마크 dataset 데이터셋 케이스 pinch',
      },
      {
        href: '/scorecards',
        label: '스코어카드',
        icon: BarChart3,
        keywords: 'scorecard 배치 평가 비교 리더보드 leaderboard 추이',
      },
      {
        href: '/schedules',
        label: '예약',
        icon: CalendarClock,
        keywords: 'schedule cron 예약 주기 회귀',
      },
      {
        href: '/queue',
        label: '작업',
        icon: Activity,
        keywords: 'queue 큐 작업 워크로드 진행 대기 런타임',
      },
      { href: '/report', label: '리포트', icon: FileText, keywords: 'report 회귀 추세' },
    ],
  },
]

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
