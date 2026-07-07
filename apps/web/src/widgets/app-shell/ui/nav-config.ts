import {
  Activity,
  BarChart3,
  Bookmark,
  Boxes,
  CalendarClock,
  Database,
  FileText,
  LayoutDashboard,
  Server,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  // 워크스페이스-상대 경로 suffix(예: '' = 개요, '/scorecards'). 렌더 시 활성 워크스페이스로 prefix → /{workspace}{suffix}.
  // nav-config 는 요청 컨텍스트가 없으므로(모듈 로드 시 워크스페이스·로케일 미상) suffix + 메시지 키만 보관한다.
  href: string
  labelKey: string // messages/*.json 의 nav.* 키 — 렌더 시 useTranslations 로 해석
  icon: LucideIcon
  exact?: boolean
  keywords?: string // command 팔레트 퍼지 매칭 보조어(한/영 병기)
}

export interface NavSection {
  heading?: string
  items: NavItem[]
}

// SaaS 표면의 1급 개념: 하니스(무엇을) · 벤치마크(무엇으로) · 스코어카드(결과) · 런타임(어디서, 워크스페이스가
// 직접 등록하는 실행 인프라 — 기본 시드 없음) + 흐름(뷰/예약/작업) + 홈(개요).
// judge/metric/model/recipe/bundle 은 엔진 부품/고급 옵션 — 내비에서 제외(라우트는 남아 URL 로 접근 가능).
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      {
        href: '',
        labelKey: 'overview',
        icon: LayoutDashboard,
        exact: true,
        keywords: 'overview home 홈 개요',
      },
      {
        href: '/harnesses',
        labelKey: 'harnesses',
        icon: Boxes,
        keywords: 'harness 하니스 에이전트 agent codex claude',
      },
      {
        href: '/datasets',
        labelKey: 'benchmarks',
        icon: Database,
        keywords: 'benchmark 벤치마크 dataset 데이터셋 케이스 case pinch',
      },
      {
        href: '/scorecards',
        labelKey: 'scorecards',
        icon: BarChart3,
        keywords: 'scorecard 스코어카드 배치 평가 비교 리더보드 leaderboard 추이',
      },
      {
        href: '/views',
        labelKey: 'views',
        icon: Bookmark,
        keywords: 'view 뷰 분석 저장 대시보드 리더보드 추이 비교 피벗 pivot',
      },
      {
        href: '/schedules',
        labelKey: 'schedules',
        icon: CalendarClock,
        keywords: 'schedule cron 예약 주기 회귀 regression',
      },
      {
        href: '/queue',
        labelKey: 'queue',
        icon: Activity,
        keywords: 'queue 큐 작업 워크로드 진행 대기 런타임 workload',
      },
      {
        href: '/runtimes',
        labelKey: 'runtimes',
        icon: Server,
        keywords: 'runtime 런타임 실행 인프라 docker k8s nomad 러너 runner',
      },
      {
        href: '/report',
        labelKey: 'report',
        icon: FileText,
        keywords: 'report 리포트 회귀 추세 trend',
      },
    ],
  },
]

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
