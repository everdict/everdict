'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'

import {
  ISSUE_FILTER_FACETS,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  IssuePriorityIcon,
  IssueStatusIcon,
  type IssueFilterFacet,
  type IssueFilters,
} from '@/entities/issue'
import { LabelDot } from '@/entities/issue-label'
import type { ListFilters } from '@/shared/lib/list-view'
import { Avatar } from '@/shared/ui/avatar'
import { FacetFilterMenu, type FacetOption, type FacetSpec } from '@/shared/ui/list-toolbar'

import type { IssueDirectories } from '../model/directories'

// 미지정 버킷의 값. 쿼리 파라미터에는 null 이 없어서 빈 문자열이 그 이름이다 — 담당자·프로젝트·사이클
// 없음은 실제로 사람들이 거르는 그룹이라 필터로 닿을 수 있어야 한다.
const UNSET = ''

// 이슈 목록의 필터 축들을 어휘로 풀어 공용 필터 메뉴에 넘긴다. 메뉴의 생김새와 동작(두 단계 · 토큰)은
// 평가 자원 목록들과 한 컴포넌트를 공유한다 — 한쪽에만 생긴 필터 UI 라는 것이 있을 수 없게.
export function IssueFilterMenu({
  filters,
  directories,
  projects,
  cycles,
  onToggle,
  onClear,
}: {
  filters: IssueFilters
  directories: IssueDirectories
  projects: { id: string; name: string }[]
  cycles: { id: string; name: string }[]
  onToggle: (facet: string, value: string) => void
  onClear: () => void
}) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')

  // 축의 값 목록. 닫힌 어휘(상태·우선순위)는 카탈로그에서, 열린 것(사람·라벨·프로젝트·사이클)은 디렉터리에서.
  const facets = useMemo((): FacetSpec[] => {
    const optionsOf = (facet: IssueFilterFacet): FacetOption[] => {
      switch (facet) {
        case 'status':
          return ISSUE_STATUSES.map((status) => ({
            value: status,
            label: tracker(`issueStatus.${status}`),
            icon: <IssueStatusIcon status={status} className="[&_svg]:size-3.5" />,
          }))
        case 'priority':
          return ISSUE_PRIORITIES.map((priority) => ({
            value: priority,
            label: tracker(`issuePriority.${priority}`),
            icon: <IssuePriorityIcon priority={priority} className="[&_svg]:size-3.5" />,
          }))
        case 'assignee':
          return [
            ...directories.members.map((member) => ({
              value: member.subject,
              label: member.name,
              icon: (
                <Avatar
                  name={member.name}
                  size="sm"
                  {...(member.avatarUrl !== undefined ? { url: member.avatarUrl } : {})}
                />
              ),
            })),
            { value: UNSET, label: t('groupUnset.assignee') },
          ]
        case 'label':
          return Object.values(directories.labels).map((label) => ({
            value: label.id,
            label: label.name,
            icon: <LabelDot color={label.color} />,
          }))
        case 'project':
          return [
            ...projects.map((project) => ({ value: project.id, label: project.name })),
            { value: UNSET, label: t('groupUnset.project') },
          ]
        case 'cycle':
          return [
            ...cycles.map((cycle) => ({ value: cycle.id, label: cycle.name })),
            { value: UNSET, label: t('groupUnset.cycle') },
          ]
      }
    }
    return ISSUE_FILTER_FACETS.map((facet) => ({
      key: facet,
      label: t(`facet.${facet}`),
      options: optionsOf(facet),
    }))
  }, [directories, projects, cycles, t, tracker])

  // 이슈의 필터는 축이 고정된 형태라(어느 축이 있는지 타입이 안다) 공용 메뉴가 쓰는 열린 레코드로 한 번 옮긴다.
  const selected = useMemo((): ListFilters => {
    const out: Record<string, readonly string[]> = {}
    for (const facet of ISSUE_FILTER_FACETS) {
      const values = filters[facet]
      if (values !== undefined && values.length > 0) out[facet] = values
    }
    return out
  }, [filters])

  return (
    <FacetFilterMenu facets={facets} filters={selected} onToggle={onToggle} onClear={onClear} />
  )
}
