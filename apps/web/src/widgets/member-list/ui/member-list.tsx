'use client'

import { useMemo } from 'react'
import { KeyRound, Search, Users } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import { isMachineSubject } from '@/entities/member'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { usePersistentFilters } from '@/shared/lib/use-persistent-filters'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'
import { ResetFiltersButton } from '@/shared/ui/reset-filters-button'
import { Tooltip } from '@/shared/ui/tooltip'

// 한 사람 = 워크스페이스 멤버십 + 그 사람이 올라가 있는 팀 로스터. 팀 소속은 멤버 레코드에 없으므로
// (별도 로스터) 서버가 합쳐서 넘긴다 — 이 위젯은 이미 합쳐진 행만 그린다.
export interface MemberRow {
  subject: string
  role: string
  addedAt: string
  name?: string
  email?: string
  avatarUrl?: string
}

type Sort = 'name' | 'joined' | 'role'

const FILTER_DEFAULTS = { query: '', role: '', sort: 'name' as Sort }

// 역할은 서버가 소유한 열린 문자열이다 — 아는 값만 번역하고 모르는 값은 그대로 보여준다(카탈로그 미스로 화면이 깨지지 않도록).
const ROLE_KEYS: Record<string, string> = {
  admin: 'roleAdmin',
  member: 'roleMember',
  viewer: 'roleViewer',
  ci: 'roleCi',
}
const ROLE_RANK: Record<string, number> = { admin: 0, member: 1, viewer: 2, ci: 3 }

// 사람 · 팀 · 역할 · 합류 — 헤더와 행이 같은 트랙을 공유해야 열이 어긋나지 않으므로 한 곳에 둔다.
// 컨테이너 쿼리다(뷰포트 아님): 같은 목록이 전체 폭에서도, 인프라 패널이 열린 좁은 칼럼에서도 그려진다.
const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 @lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_88px] @2xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_88px_96px]'

// 사람 이름 — 이름 > 이메일 로컬파트 > 축약한 subject. 불투명한 Keycloak sub 를 그대로 세우면 사람 목록이 id 목록이 된다.
function labelOf(m: MemberRow): string {
  if (m.name) return m.name
  if (m.email) return m.email.split('@')[0] ?? m.email
  return fmtSubject(m.subject)
}

export function MemberList({
  workspace,
  members,
  currentSubject,
}: {
  workspace: string
  members: MemberRow[]
  currentSubject?: string
}) {
  const t = useTranslations('membersDirectory')
  const timeZone = useTimeZone()
  const locale = useLocale()
  const { values, set, reset, dirty } = usePersistentFilters(
    `members:${workspace}`,
    FILTER_DEFAULTS
  )
  const { query, role, sort } = values

  const roleLabel = (value: string): string => {
    const key = ROLE_KEYS[value]
    return key ? t(key) : value
  }


  const roleOptions = useMemo(() => {
    const seen = [...new Set(members.map((m) => m.role))].sort(
      (a, b) => (ROLE_RANK[a] ?? 9) - (ROLE_RANK[b] ?? 9)
    )
    return [
      { value: '', label: t('allRoles') },
      ...seen.map((r) => ({ value: r, label: roleLabel(r) })),
    ]
  }, [members, t])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = members.filter((m) => {
      if (role && m.role !== role) return false
      if (!q) return true
      const hay = [
        m.name ?? '',
        m.email ?? '',
        m.subject,
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
    const by: Record<Sort, (a: MemberRow, b: MemberRow) => number> = {
      name: (a, b) => labelOf(a).localeCompare(labelOf(b)),
      joined: (a, b) => b.addedAt.localeCompare(a.addedAt),
      role: (a, b) =>
        (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || labelOf(a).localeCompare(labelOf(b)),
    }
    return [...matched].sort(by[sort])
  }, [members, query, role, sort])

  const sortOptions: { value: Sort; label: string }[] = [
    { value: 'name', label: t('sortName') },
    { value: 'joined', label: t('sortJoined') },
    { value: 'role', label: t('sortRole') },
  ]

  return (
    <div className="@container space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] max-w-[340px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => set('query', e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
            aria-label={t('searchPlaceholder')}
          />
        </div>
        {roleOptions.length > 2 && (
          <Combobox
            options={roleOptions}
            value={role}
            onChange={(v) => set('role', v)}
            className="w-[130px]"
            aria-label={t('allRoles')}
          />
        )}
        <Combobox
          options={sortOptions.map((s) => ({ value: s.value, label: s.label }))}
          value={sort}
          onChange={(v) => set('sort', v as Sort)}
          className="w-[130px] @2xl:ml-auto"
          align="end"
          aria-label={t('sortAria')}
        />
        {dirty && <ResetFiltersButton onClick={reset} />}
      </div>

      <p className="px-0.5 text-[12px] text-muted-foreground">
        {visible.length === members.length
          ? t('countAll', { total: members.length })
          : t('countFiltered', { shown: visible.length, total: members.length })}
      </p>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={members.length === 0 ? t('emptyTitle') : t('noMatchTitle')}
          hint={members.length === 0 ? t('emptyHint') : t('noMatchHint')}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {/* 열 이름 — 숨겨진 셀은 트랙을 차지하지 않으므로 행과 같은 순서로 두면 좁은 폭에서도 헤더가 따라 접힌다. */}
          <div
            className={cn(
              ROW,
              'h-8 border-b border-border/70 bg-muted/20 text-[11px] font-[510] uppercase tracking-[0.04em] text-faint'
            )}
          >
            <span>{t('colName')}</span>
            <span className="hidden @lg:block">{t('colTeams')}</span>
            <span>{t('colRole')}</span>
            <span className="hidden @2xl:block">{t('colJoined')}</span>
          </div>
          <ul className="divide-y divide-border/70">
            {visible.map((m) => {
              const machine = isMachineSubject(m.subject)
              const name = labelOf(m)
              return (
                <li
                  key={m.subject}
                  // 이메일/부제가 있는 행만 두 줄이 되면 리듬이 깨진다 — 최소 높이로 행 높이를 고정한다.
                  className={cn(ROW, 'min-h-[52px] py-2 transition-colors hover:bg-accent/40')}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {machine ? (
                      <Tooltip content={t('apiKeyMember')} className="shrink-0">
                        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground ring-1 ring-inset ring-border">
                          <KeyRound className="size-3.5" />
                        </span>
                      </Tooltip>
                    ) : (
                      <Avatar
                        name={name}
                        size="lg"
                        className="rounded-full"
                        {...(m.avatarUrl ? { url: m.avatarUrl } : {})}
                      />
                    )}
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'truncate text-[13px] font-[510] text-foreground',
                            machine && 'font-mono text-[12px]'
                          )}
                        >
                          {machine ? m.subject : name}
                        </span>
                        {m.subject === currentSubject && <Badge tone="outline">{t('you')}</Badge>}
                      </span>
                      {machine ? (
                        <span className="block truncate text-[12px] text-muted-foreground">
                          {t('apiKeyMember')}
                        </span>
                      ) : (
                        m.email && (
                          // 이메일은 그대로 mailto 링크다 — 디렉토리에서 가장 흔한 다음 행동이 연락이라, 별도 액션 버튼을 두지 않는다.
                          <a
                            href={`mailto:${m.email}`}
                            className="block truncate text-[12px] text-muted-foreground hover:text-foreground hover:underline"
                          >
                            {m.email}
                          </a>
                        )
                      )}
                    </span>
                  </span>

                  <span
                    className={cn(
                      'truncate text-[12px]',
                      m.role === 'admin' ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {roleLabel(m.role)}
                  </span>

                  <span
                    className="hidden text-[12px] tabular-nums text-faint @2xl:block"
                    title={fmtDateTimeFull(m.addedAt, { locale, timeZone })}
                  >
                    {fmtDateTime(m.addedAt, timeZone)}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
