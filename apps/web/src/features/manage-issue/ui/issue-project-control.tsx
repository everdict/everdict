'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { projectStatusIcon, type ProjectStatus } from '@/entities/project'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

import { updateIssueAction } from '../api/issues'

export interface IssueProjectOption {
  id: string
  name: string
  // 상태 아이콘까지 들고 온다 — 끝난 프로젝트에 이슈를 넣는 것과 진행 중인 곳에 넣는 것은 다른 결정이다.
  status: ProjectStatus
}

// 고를 것이 이만큼 넘어가면 검색 줄을 낸다 — Combobox 와 같은 문턱값(스크롤로만 찾게 두지 않는다).
const SEARCH_FROM = 7

function ProjectName({ project }: { project: IssueProjectOption }) {
  const Icon = projectStatusIcon(project.status)
  return (
    <>
      <Icon className="size-3.5 shrink-0 text-faint" />
      <span className="truncate">{project.name}</span>
    </>
  )
}

// 이슈가 속한 프로젝트 — 상태·우선순위·팀·라벨과 같은 자리(속성 열)에서 바로 바꾼다. 예전에는 붙어 있을 때만
// 링크 한 줄로 보였고, 넣고 빼는 길은 ⋯ 메뉴의 편집 다이얼로그 안에만 있었다 — 이슈를 프로젝트에 넣으려고
// 이슈 전체 폼을 여는 건 Linear 의 동선이 아니다.
//
// 이미 붙어 있는 프로젝트는 계속 링크로 남는다(속성 열에서 프로젝트로 가는 유일한 길이다). 바꾸는 것은 그
// 옆의 작은 트리거가 맡아, 읽는 자리와 바꾸는 자리를 겹치지 않게 한다.
export function IssueProjectControl({
  workspace,
  id,
  project,
  projects,
  canWrite,
}: {
  workspace: string
  id: string
  project: IssueProjectOption | undefined
  // 이 이슈의 팀이 올라 있는 프로젝트들(호출한 화면이 `?team=` 으로 걸러 온다). 프로젝트는 여러 팀이 함께
  // 하지만 아무 팀이나 넣을 수 있는 건 아니다 — 이슈는 자기 팀이 올라 있는 프로젝트에만 들어가고, 그건
  // 제어 평면이 강제한다. 그래서 여기 있는 것은 전부 실제로 고를 수 있는 것들이다.
  projects: IssueProjectOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [pending, startTransition] = useTransition()

  // `null` 은 비운다 — 프로젝트에서 뺀다는 뜻이고, `undefined`(손대지 않음)와 절대 섞이면 안 된다.
  function assign(projectId: string | null): void {
    if (projectId === (project?.id ?? null)) return
    startTransition(async () => {
      const r = await updateIssueAction(id, { projectId })
      if (!r.ok) {
        toast.error(r.error ?? t('projectError'))
        return
      }
      router.refresh()
    })
  }

  const chip = project ? (
    <Link
      href={`/${workspace}/projects/${encodeURIComponent(project.id)}`}
      className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
    >
      <ProjectName project={project} />
    </Link>
  ) : null

  if (!canWrite) return chip

  const needle = query.trim().toLocaleLowerCase()
  const choices = projects.filter(
    (p) => needle === '' || p.name.toLocaleLowerCase().includes(needle)
  )
  const searchable = projects.length > SEARCH_FROM

  return (
    <div className="flex min-w-0 items-center gap-1">
      {chip}
      <DropdownMenu
        align="end"
        contentClassName={cn('p-1', searchable && 'w-64')}
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('projectControlLabel')}
            disabled={pending}
            className={cn(
              'shrink-0 transition-colors disabled:opacity-50',
              project
                ? 'inline-flex size-5 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground'
                : // 아직 아무 프로젝트에도 없는 이슈에서는 이 버튼이 유일한 안내다 — 그때만 글자를 단다.
                  'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:border-border-strong hover:bg-accent hover:text-foreground'
            )}
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : project ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <>
                <Plus className="size-3" />
                <span>{t('projectAdd')}</span>
              </>
            )}
          </button>
        )}
      >
        {searchable && (
          <div className="p-1">
            <Input
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('projectSearchPlaceholder')}
              // 이 컨트롤이 폼 안에 놓이는 날을 대비한다 — Enter 가 폼을 제출해 버리면 고르다 말고 저장된다.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
            />
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          {choices.map((option) => {
            const Icon = projectStatusIcon(option.status)
            return (
              <DropdownItem
                key={option.id}
                icon={<Icon />}
                {...(option.id === project?.id ? { trailing: <Check className="size-3.5" /> } : {})}
                onSelect={() => assign(option.id)}
              >
                {option.name}
              </DropdownItem>
            )
          })}
          {choices.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-faint">{t('projectNoMatch')}</p>
          )}
        </div>
        {project && (
          <>
            <DropdownSeparator />
            <DropdownItem icon={<X className="size-3.5" />} onSelect={() => assign(null)}>
              {t('projectClear')}
            </DropdownItem>
          </>
        )}
      </DropdownMenu>
    </div>
  )
}
