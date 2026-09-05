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

// The unspecified bucket's value. A query parameter has no null, so the empty string is its name — no assignee, no project and no cycle are
// groups people genuinely filter by and have to be reachable as filters.
const UNSET = ''

// It resolves the issue list's filter axes into a vocabulary and hands them to the shared filter menu. The menu's appearance and behaviour
// (two steps · tokens) share ONE component with the evaluation resource lists — so a filter UI that exists on only one of them cannot happen.
export function IssueFilterMenu({
  filters,
  directories,
  projects,
  onToggle,
  onClear,
}: {
  filters: IssueFilters
  directories: IssueDirectories
  projects: { id: string; name: string }[]
  onToggle: (facet: string, value: string) => void
  onClear: () => void
}) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')

  // The value list per axis. A closed vocabulary (status, priority) comes from the catalog; an open one (people, labels, projects, cycles) from the directory.
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
      }
    }
    return ISSUE_FILTER_FACETS.map((facet) => ({
      key: facet,
      label: t(`facet.${facet}`),
      options: optionsOf(facet),
    }))
  }, [directories, projects, t, tracker])

  // The issue filters have a fixed shape (the TYPE knows which axes exist), so they are moved once into the open record the shared menu uses.
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
