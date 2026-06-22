import {
  Activity,
  BarChart3,
  Boxes,
  Cpu,
  Database,
  FileText,
  Gauge,
  Gavel,
  LayoutDashboard,
  Server,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
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

// 사이드바 + Cmd+K 공용 IA. Linear 식 섹션 그룹화: 평가 운영 / 리소스 구성.
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { href: '/dashboard', label: '개요', icon: LayoutDashboard, exact: true, keywords: 'overview home' },
      { href: '/dashboard/runs', label: 'Runs', icon: Activity, keywords: '런 실행 평가' },
      { href: '/dashboard/scorecards', label: '스코어카드', icon: BarChart3, keywords: 'scorecard 배치 평가 비교' },
      { href: '/dashboard/report', label: '리포트', icon: FileText, keywords: 'report 회귀 추세' },
    ],
  },
  {
    heading: '리소스',
    items: [
      { href: '/dashboard/datasets', label: '데이터셋', icon: Database, keywords: 'dataset 벤치마크' },
      { href: '/dashboard/harnesses', label: '하니스', icon: Boxes, keywords: 'harness 에이전트' },
      { href: '/dashboard/judges', label: 'Judge', icon: Gavel, keywords: '심사 judge llm' },
      { href: '/dashboard/runtimes', label: '런타임', icon: Server, keywords: 'runtime 인프라 k8s nomad' },
      { href: '/dashboard/metrics', label: '메트릭', icon: Gauge, keywords: 'metric 지표' },
      { href: '/dashboard/models', label: '모델', icon: Cpu, keywords: 'model provider llm' },
    ],
  },
]

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
