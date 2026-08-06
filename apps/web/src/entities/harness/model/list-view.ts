import type { ListDisplay, ListViewSpec } from '@/shared/lib/list-view'

import type { Harness } from './schema'

// 하네스 목록이 자기에 대해 아는 것 — 어느 축으로 거르고, 어떻게 묶고, 무엇으로 정렬하는가. 어휘가 여기
// 있는 이유는 목록 화면과 주소 해석이 같은 단어를 써야 하기 때문이다(모르는 축은 주소에서 버려진다).
//
// 팀이 축의 하나인 것이 이 목록의 핵심 변화다. 한동안 팀은 경로였지만(`…/team/ENG/harnesses`), 사람은
// "우리 팀 하네스"를 팀 화면에서 찾는 게 아니라 하네스 목록에서 좁혀 찾는다.
export const HARNESS_FACETS = ['team', 'category', 'kind', 'creator', 'tag'] as const
export const HARNESS_GROUPINGS = [
  'none',
  'template',
  'category',
  'kind',
  'team',
  'creator',
] as const
export const HARNESS_ORDERS = ['name', 'updated', 'created', 'versions'] as const

// 기본은 형상(템플릿)으로 묶기 — env 나 모델 하나만 다른 변형은 서로 무관한 하네스가 아니라 한 형상의
// 형제이고, 그렇게 보이지 않으면 목록이 "비슷한 이름 열두 개"가 된다.
export const DEFAULT_HARNESS_DISPLAY: ListDisplay = { grouping: 'template', order: 'name' }

function versionsOf(harness: Harness): number {
  return harness.versionCount ?? harness.versions.length
}

// 하네스를 부르는 라벨 = 버전 태그의 합집합(최신 버전 우선, 중복 제거). 하네스가 많아지면 이름만으로
// 각각이 뭔지 안 보인다는 요구의 답이 이것이다 — 어느 버전에 붙었든 사람이 단 라벨은 목록에서 그
// 하네스의 이름표로 남는다(새 버전을 찍어도 옛 버전의 라벨이 사라지지 않도록 최신 것만 쓰지 않는다).
// 데이터셋과 같은 이유로 거르기 전용이다: 여럿 들 수 있어 묶으면 그룹 합이 목록보다 커진다.
export function harnessTags(harness: Harness): string[] {
  const byVersion = harness.versionTags
  if (!byVersion) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const version of [...harness.versions].reverse()) {
    for (const tag of byVersion[version] ?? []) {
      if (!seen.has(tag)) {
        seen.add(tag)
        tags.push(tag)
      }
    }
  }
  return tags
}

export const harnessListSpec: ListViewSpec<Harness> = {
  facetValues: (harness, facet) => {
    switch (facet) {
      case 'team':
        return harness.teamId === undefined ? [] : [harness.teamId]
      case 'category':
        return harness.category === undefined ? [] : [harness.category]
      case 'kind':
        return harness.kind === undefined ? [] : [harness.kind]
      case 'creator':
        return harness.createdBy === undefined ? [] : [harness.createdBy]
      case 'tag':
        return harnessTags(harness)
      default:
        return []
    }
  },
  // 검색이 훑는 것은 사람이 그 하네스를 부를 만한 모든 이름이다 — id 뿐 아니라 부제(모델·커맨드)와
  // 형상, 그리고 사람이 직접 단 버전 태그까지.
  searchText: (harness) =>
    [
      harness.id,
      harness.category ?? '',
      harness.kind ?? '',
      harness.subtitle ?? '',
      harness.templateId ?? '',
      ...harnessTags(harness),
    ].join(' '),
  groupKey: (harness, grouping) => {
    switch (grouping) {
      case 'template':
        return harness.templateId ?? null
      case 'category':
        return harness.category ?? null
      case 'kind':
        return harness.kind ?? null
      case 'team':
        return harness.teamId ?? null
      case 'creator':
        return harness.createdBy ?? null
      default:
        return null
    }
  },
  compare: (a, b, order) => {
    switch (order) {
      case 'updated':
        return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
      case 'created':
        return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
      case 'versions':
        return versionsOf(b) - versionsOf(a)
      default:
        return a.id.localeCompare(b.id)
    }
  },
}
