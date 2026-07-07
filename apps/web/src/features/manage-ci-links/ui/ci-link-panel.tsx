'use client'

import { useMemo, useState, useTransition } from 'react'
import { GitBranch, Plus } from 'lucide-react'

import type { CiLink } from '@/entities/ci-link'
import type { HarnessKind } from '@/entities/harness'
import { fmtSubject } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

import { deleteCiLinkAction } from '../api/manage-ci-links'
import { ConnectRepoDialog, hostLabel } from './connect-repo-dialog'
import { SetupPrButton } from './setup-pr-button'

// kind → 이 하니스가 CI 에 노출할 빌드 슬롯 후보. service=서비스 이름, command=image, process=없음.
function slotChoicesFor(kind: HarnessKind, serviceNames: string[]): string[] {
  if (kind === 'service') return serviceNames
  if (kind === 'command') return ['image']
  return []
}

// link 식별 키 — 같은 "owner/name" 이 github.com 과 GHE 양쪽에 링크될 수 있어 host 까지 포함한다.
const linkKey = (l: Pick<CiLink, 'repository' | 'host'>) =>
  `${l.host ?? 'github.com'}:${l.repository}`

// 하니스 상세의 "CI 연동" 패널 — 이 하니스에 연결된 레포 링크 목록 + "GitHub 레포 연결"(zero-input) + 셋업 PR/해제.
// 조회는 viewer+, 저장/해제는 admin(컨트롤플레인 강제). 링크의 존재가 그 레포의 keyless CI 신뢰를 부여한다.
export function CiLinkPanel({
  harnessId,
  kind,
  serviceNames,
  datasets,
  initialLinks,
  canWrite,
  workspace,
}: {
  harnessId: string
  kind: HarnessKind
  serviceNames: string[]
  datasets: string[]
  initialLinks: CiLink[] // 이 하니스에 매칭된 링크(서버에서 필터)
  canWrite: boolean
  workspace: string
}) {
  const [links, setLinks] = useState<CiLink[]>(initialLinks)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmRepo, setConfirmRepo] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  const slotChoices = useMemo(() => slotChoicesFor(kind, serviceNames), [kind, serviceNames])

  // 다이얼로그/삭제는 워크스페이스 전체 링크를 돌려준다 — 이 하니스 것만 골라 로컬 상태로.
  function applyLinks(all: CiLink[]) {
    setLinks(all.filter((l) => l.harness === harnessId))
  }

  function onDelete(link: CiLink) {
    setError(undefined)
    startTransition(async () => {
      const r = await deleteCiLinkAction(link.repository, link.host)
      setConfirmRepo(undefined)
      if (r.ok && r.links) applyLinks(r.links)
      else setError(r.error ?? '링크 해제에 실패했습니다.')
    })
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-[15px] font-[560] tracking-[-0.01em] text-foreground">CI 연동</h2>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            GitHub 레포를 이 하니스에 연결하면, PR·머지마다 CI가 이미지를 만들어 자동으로 평가해요.
            따로 키를 넣지 않아도 돼요.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => setDialogOpen(true)}
        >
          <Plus />
          GitHub 레포 연결
        </Button>
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {links.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-4 py-6 text-center">
          <p className="text-[13px] text-muted-foreground">아직 연결된 레포가 없어요.</p>
          <p className="mt-1 text-[12px] text-faint">
            {canWrite
              ? '‘GitHub 레포 연결’을 눌러 레포를 붙여보세요.'
              : '레포 연결은 관리자가 설정해요.'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-lg border bg-card shadow-raise">
          {links.map((l) => {
            const slotNames = Object.keys(l.slots ?? {})
            return (
              <li key={linkKey(l)} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[12px] text-foreground">
                      <GitBranch className="size-3 text-muted-foreground/70" />
                      {l.repository}
                    </span>
                    {l.host && (
                      // GHE link — 어느 인스턴스인지 호스트명 배지(github.com 은 무표기).
                      <span className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                        {hostLabel(l.host)}
                      </span>
                    )}
                    {l.disabled && <Badge tone="warning">비활성</Badge>}
                    {l.dataset && (
                      <span className="text-[11px] text-muted-foreground">
                        데이터셋 <span className="font-mono text-foreground/85">{l.dataset}</span>
                      </span>
                    )}
                    {/* PR 평가 발화 방식 — 기본(both)은 무표기, 좁힌 경우만 표시. */}
                    {l.trigger === 'auto' && (
                      <span className="text-[11px] text-muted-foreground">PR 자동만</span>
                    )}
                    {l.trigger === 'comment' && (
                      <span className="text-[11px] text-muted-foreground">
                        <span className="font-mono text-foreground/85">/evaluate</span> 코멘트만
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <SetupPrButton repository={l.repository} host={l.host} onError={setError} />
                    {canWrite &&
                      (confirmRepo === linkKey(l) ? (
                        <span className="flex items-center gap-2">
                          <Button
                            variant="destructive"
                            size="xs"
                            disabled={pending}
                            onClick={() => onDelete(l)}
                          >
                            해제 확인
                          </Button>
                          <button
                            type="button"
                            className="text-[12px] text-muted-foreground hover:text-foreground"
                            onClick={() => setConfirmRepo(undefined)}
                          >
                            취소
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="text-[12px] font-[510] text-destructive hover:underline"
                          onClick={() => setConfirmRepo(linkKey(l))}
                        >
                          해제
                        </button>
                      ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {slotNames.length > 0 ? (
                    slotNames.map((name) => {
                      const path = l.slots?.[name]?.path
                      return (
                        <code
                          key={name}
                          className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          <span className="text-foreground/85">{name}</span>
                          {path && <span className="text-faint">· {path}</span>}
                        </code>
                      )
                    })
                  ) : (
                    <span className="text-[11px] text-faint">슬롯 없음 (트리거만)</span>
                  )}
                  <span className="ml-1 text-[11px] text-faint">
                    등록 {fmtSubject(l.createdBy)}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <ConnectRepoDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        harnessId={harnessId}
        kind={kind}
        slotChoices={slotChoices}
        datasets={datasets}
        workspace={workspace}
        canWrite={canWrite}
        onSaved={applyLinks}
      />
    </section>
  )
}
