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
  // 워크스페이스-상대 경로 suffix(예: '' = 개요, '/runs'). 렌더 시 활성 워크스페이스로 prefix → /{workspace}{suffix}.
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

// 사이드바 + Cmd+K 공용 IA. Linear 식 섹션 그룹화: 평가 운영 / 리소스 구성. href 는 워크스페이스-상대 suffix.
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { href: '', label: '개요', icon: LayoutDashboard, exact: true, keywords: 'overview home' },
      { href: '/runs', label: 'Runs', icon: Activity, keywords: '런 실행 평가' },
      {
        href: '/scorecards',
        label: '스코어카드',
        icon: BarChart3,
        keywords: 'scorecard 배치 평가 비교',
      },
      { href: '/report', label: '리포트', icon: FileText, keywords: 'report 회귀 추세' },
    ],
  },
  {
    heading: '리소스',
    items: [
      { href: '/datasets', label: '데이터셋', icon: Database, keywords: 'dataset 벤치마크' },
      { href: '/harnesses', label: '하니스', icon: Boxes, keywords: 'harness 에이전트' },
      { href: '/judges', label: 'Judge', icon: Gavel, keywords: '심사 judge llm' },
      { href: '/runtimes', label: '런타임', icon: Server, keywords: 'runtime 인프라 k8s nomad' },
      { href: '/metrics', label: '메트릭', icon: Gauge, keywords: 'metric 지표' },
      { href: '/models', label: '모델', icon: Cpu, keywords: 'model provider llm' },
    ],
  },
]

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
