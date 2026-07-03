'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { GitBranch } from 'lucide-react'

import type { CiLink } from '@/entities/ci-link'
import { fmtSubject } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

import { deleteCiLinkAction } from '../api/manage-ci-links'

// 워크스페이스 설정의 "CI 연동" 섹션 — 이 워크스페이스의 모든 레포 링크(레포↔하니스 슬롯 = OIDC trust) 목록 + 해제(admin).
// 링크의 "존재"가 그 레포의 keyless CI(OIDC) 신뢰를 부여하므로, 여기 목록은 곧 신뢰 부여된 레포 목록이다.
export function CiLinksSettings({
  initialLinks,
  canWrite,
}: {
  initialLinks: CiLink[]
  canWrite: boolean
}) {
  const { workspace } = useParams<{ workspace: string }>()
  const [links, setLinks] = useState<CiLink[]>(initialLinks)
  const [confirmRepo, setConfirmRepo] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onDelete(repository: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await deleteCiLinkAction(repository)
      setConfirmRepo(undefined)
      if (r.ok && r.links) setLinks(r.links)
      else setError(r.error ?? '링크 해제에 실패했습니다.')
    })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">CI 연동</h3>
        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          GitHub 레포와 하니스를 잇는 링크예요. 링크가{' '}
          <span className="font-[510]">있으면</span> 그 레포의 CI를 이
          워크스페이스가 신뢰한다는 뜻이라, 따로 키 없이 CI가 평가를 보내요. 레포 연결과 셋업 PR은
          각 하니스 상세의 <span className="font-[510]">CI 연동</span> 패널에서 해요.
        </p>
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {links.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          아직 연결된 레포가 없어요. 하니스 상세의 CI 연동 패널에서 레포를 연결해보세요.
        </p>
      ) : (
        <SettingsList>
          {links.map((l) => {
            const slotNames = Object.keys(l.slots ?? {})
            return (
              <SettingsRow
                key={l.repository}
                label={
                  <span className="inline-flex items-center gap-1.5 font-mono">
                    <GitBranch className="size-3.5 text-muted-foreground/70" />
                    {l.repository}
                    {l.disabled && <Badge tone="warning">비활성</Badge>}
                  </span>
                }
                hint={
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <span>
                      하니스 <span className="font-mono text-foreground/80">{l.harness}</span>
                    </span>
                    {l.dataset && (
                      <span>
                        · 데이터셋 <span className="font-mono text-foreground/80">{l.dataset}</span>
                      </span>
                    )}
                    <span>· 슬롯 {slotNames.length > 0 ? slotNames.join(', ') : '없음'}</span>
                    <span>· 등록 {fmtSubject(l.createdBy)}</span>
                  </span>
                }
              >
                <Link
                  href={`/${encodeURIComponent(workspace)}/harnesses/${encodeURIComponent(l.harness)}`}
                  className="text-[12px] font-[510] text-link hover:text-foreground"
                >
                  하니스 →
                </Link>
                {canWrite &&
                  (confirmRepo === l.repository ? (
                    <span className="flex items-center gap-2">
                      <Button
                        variant="destructive"
                        size="xs"
                        disabled={pending}
                        onClick={() => onDelete(l.repository)}
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
                      onClick={() => setConfirmRepo(l.repository)}
                    >
                      해제
                    </button>
                  ))}
              </SettingsRow>
            )
          })}
        </SettingsList>
      )}

      {!canWrite && links.length > 0 && (
        <p className="text-[12px] text-muted-foreground">
          링크를 해제하려면 관리자 권한이 필요해요.
        </p>
      )}
    </div>
  )
}
