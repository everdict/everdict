'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, ChevronDown, ChevronRight, Copy, Loader2, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { WorkspaceImageInspect } from '@/entities/workspace-image'
import { copyText } from '@/shared/lib/clipboard'
import { fmtBytes, fmtDateTime } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Markdown } from '@/shared/ui/markdown'
import { SectionHeader } from '@/shared/ui/section-header'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  inspectWorkspaceImageAction,
  removeWorkspaceImageAction,
} from '../api/manage-workspace-images'

// 이 리포지토리를 선언한 환경 capability — 이미지 상세가 보여주는 "everdict 쪽 컨텍스트". bytes(레지스트리)와
// 에이전트 컨텍스트(instructions/contents)가 합쳐져야 환경 이미지라는 도메인 판단의 UI 면이다.
export interface ImageEnvironmentLink {
  id: string
  version: string
  name: string
  description: string
  instructions: string
  benchmark?: string
  packages: string[]
  os?: string
  arch?: string
}

// OCI history 의 created_by 를 Dockerfile 문장으로 되돌린다: "#(nop)" 뒤가 메타데이터 인스트럭션 본문이고,
// "/bin/sh -c …"는 RUN 이 셸로 감싼 형태다. 원문을 해치지 않는 선에서만 정돈한다(모르는 형태는 그대로).
function dockerfileStep(createdBy: string): string {
  const nop = createdBy.match(/#\(nop\)\s+(.*)$/)
  if (nop?.[1]) return nop[1].trim()
  return createdBy.replace(/^\/bin\/sh -c\s+/, 'RUN ').trim()
}

// Settings › Images › 상세 — JFrog 류 레지스트리 UI 의 문법: 버전(태그)이 먼저, 고른 버전의 다이제스트·크기·
// 플랫폼, 그 아래 "이 이미지가 어떻게 만들어졌나"(OCI config history)와 런타임 계약, 마지막으로 everdict 쪽
// 컨텍스트(이 이미지를 선언한 환경). 상세는 라우트다 — 우측 대화 패널과 나란히 두고 쓰는 화면이므로.
export function WorkspaceImageDetail({
  workspace,
  name,
  image,
  tags,
  initialReference,
  initialInspect,
  environments,
  canPush,
}: {
  workspace: string
  name: string
  image: string // 태그 없는 ref — "<endpoint>/<namespace>/<name>"
  tags: string[]
  initialReference: string | null
  initialInspect: WorkspaceImageInspect | null
  environments: ImageEnvironmentLink[]
  canPush: boolean
}) {
  const t = useTranslations('workspaceImages')
  const locale = useLocale()
  const router = useRouter()
  const [selected, setSelected] = useState<string | null>(initialReference)
  const [details, setDetails] = useState<Record<string, WorkspaceImageInspect | null>>(
    initialReference ? { [initialReference]: initialInspect } : {}
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [removing, startRemoving] = useTransition()

  const inspect = selected ? (details[selected] ?? null) : null
  const selectedRef = selected ? `${image}:${selected}` : image

  const select = (tag: string) => {
    setSelected(tag)
    if (tag in details) return
    startTransition(async () => {
      const res = await inspectWorkspaceImageAction(name, tag)
      // 실패해도 행은 남는다 — null 캐시로 "요약을 못 읽었다"를 표시하고 다시 고르면 재시도하지 않는다.
      setDetails((prev) => ({ ...prev, [tag]: res.ok ? res.inspect : null }))
      if (!res.ok) setError(res.error)
    })
  }

  const unpublish = () => {
    setError(null)
    startRemoving(async () => {
      const res = await removeWorkspaceImageAction(name)
      if (res.ok) router.push(`/${workspace}/settings/images`)
      else setError(res.error)
    })
  }

  return (
    <div className="space-y-6">
      {/* 메타 스트립 — 고른 버전의 ref 가 곧 스펙에 들어가는 값이므로 복사가 1클릭이어야 한다. */}
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
        <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
          {selectedRef}
        </code>
        <button
          type="button"
          onClick={() => copyText(selectedRef, undefined, locale)}
          aria-label={t('copyRef')}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <Copy className="size-3.5" />
        </button>
        {inspect?.os && inspect?.architecture && (
          <Badge tone="outline">
            {inspect.os}/{inspect.architecture}
          </Badge>
        )}
        {inspect?.sizeBytes !== undefined && (
          <Badge tone="outline">{fmtBytes(inspect.sizeBytes)}</Badge>
        )}
        {inspect?.created && <Badge tone="outline">{fmtDateTime(inspect.created)}</Badge>}
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      {/* 버전이 먼저다 — 리포지토리는 껍데기고 사용자가 고르는 것은 태그다. */}
      <section className="space-y-3">
        <SectionHeader title={t('versionsTitle')} />
        {tags.length === 0 ? (
          <Callout tone="info">{t('noTags')}</Callout>
        ) : (
          <SettingsList>
            {tags.map((tag) => {
              const active = selected === tag
              const detail = details[tag]
              return (
                <SettingsRow
                  key={tag}
                  label={
                    <button
                      type="button"
                      onClick={() => select(tag)}
                      className={cn(
                        'flex items-center gap-1.5 text-left font-medium hover:underline',
                        active && 'text-foreground'
                      )}
                    >
                      {active ? (
                        <ChevronDown className="size-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0" />
                      )}
                      {tag}
                      {active && <Check className="size-3.5 text-primary" />}
                    </button>
                  }
                  hint={
                    active && detail?.digest ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <code className="font-mono text-[11px]" title={detail.digest}>
                          {detail.digest.slice(0, 19)}…
                        </code>
                        <button
                          type="button"
                          onClick={() => copyText(detail.digest ?? '', undefined, locale)}
                          aria-label={t('copyDigest')}
                          className="text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <Copy className="size-3" />
                        </button>
                        {detail.platforms?.map((p) => (
                          <Badge key={p} tone="outline">
                            {p}
                          </Badge>
                        ))}
                      </span>
                    ) : active && pending ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="size-3 animate-spin" />
                        {t('loadingInspect')}
                      </span>
                    ) : active && tag in details ? (
                      t('inspectUnavailable')
                    ) : undefined
                  }
                >
                  {active && detail?.layerCount !== undefined && (
                    <span className="text-xs text-muted-foreground">
                      {t('layerCount', { count: detail.layerCount })}
                    </span>
                  )}
                  {active && detail?.sizeBytes !== undefined && (
                    <span className="text-xs text-muted-foreground">
                      {fmtBytes(detail.sizeBytes)}
                    </span>
                  )}
                </SettingsRow>
              )
            })}
          </SettingsList>
        )}
      </section>

      {/* 어떻게 만들어졌나 — OCI config history 를 Dockerfile 문장으로 되돌려 보여준다. */}
      {inspect?.history && inspect.history.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title={
              <span className="inline-flex items-center gap-1.5">
                {t('buildTitle')}
                <InfoTip content={t('buildTip')} />
              </span>
            }
          />
          <ol className="divide-y divide-border/70 overflow-hidden rounded-lg border bg-card shadow-raise">
            {inspect.history.map((step, i) => (
              <li
                key={`${i}-${step.createdBy.slice(0, 24)}`}
                className={cn(
                  'flex items-start gap-3 px-3 py-2',
                  step.emptyLayer && 'text-muted-foreground'
                )}
              >
                <span className="mt-0.5 w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {i + 1}
                </span>
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed">
                  {dockerfileStep(step.createdBy)}
                </code>
                {step.created && (
                  <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">
                    {fmtDateTime(step.created)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 런타임 계약 — 이미지가 실행될 때의 약속. 빈 항목은 렌더하지 않는다(상세뷰 관습). */}
      {inspect?.config && (
        <section className="space-y-3">
          <SectionHeader title={t('runtimeTitle')} />
          <SettingsList>
            {inspect.config.entrypoint && (
              <SettingsRow label={t('runtimeEntrypoint')}>
                <code className="font-mono text-[12px]">{inspect.config.entrypoint.join(' ')}</code>
              </SettingsRow>
            )}
            {inspect.config.cmd && (
              <SettingsRow label={t('runtimeCmd')}>
                <code className="font-mono text-[12px]">{inspect.config.cmd.join(' ')}</code>
              </SettingsRow>
            )}
            {inspect.config.workingDir && (
              <SettingsRow label={t('runtimeWorkingDir')}>
                <code className="font-mono text-[12px]">{inspect.config.workingDir}</code>
              </SettingsRow>
            )}
            {inspect.config.user && (
              <SettingsRow label={t('runtimeUser')}>
                <code className="font-mono text-[12px]">{inspect.config.user}</code>
              </SettingsRow>
            )}
            {inspect.config.exposedPorts && (
              <SettingsRow label={t('runtimePorts')}>
                <span className="flex flex-wrap justify-end gap-1">
                  {inspect.config.exposedPorts.map((p) => (
                    <Badge key={p} tone="outline">
                      {p}
                    </Badge>
                  ))}
                </span>
              </SettingsRow>
            )}
            {inspect.config.env && (
              <SettingsRow label={t('runtimeEnv')}>
                <span className="flex max-w-md flex-col items-end gap-0.5">
                  {inspect.config.env.map((e) => (
                    <code key={e} className="break-all font-mono text-[11px] text-muted-foreground">
                      {e}
                    </code>
                  ))}
                </span>
              </SettingsRow>
            )}
            {inspect.config.labels && (
              <SettingsRow label={t('runtimeLabels')}>
                <span className="flex max-w-md flex-col items-end gap-0.5">
                  {Object.entries(inspect.config.labels).map(([k, v]) => (
                    <code key={k} className="break-all font-mono text-[11px] text-muted-foreground">
                      {k}={v}
                    </code>
                  ))}
                </span>
              </SettingsRow>
            )}
          </SettingsList>
        </section>
      )}

      {/* everdict 쪽 컨텍스트 — 이 이미지를 선언한 환경 capability. bytes 만이 아니라 에이전트가 받는 지침까지가
          환경 이미지라는 도메인 판단을 상세에서 그대로 보여준다. 없으면 섹션째 숨긴다. */}
      {environments.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title={
              <span className="inline-flex items-center gap-1.5">
                {t('environmentsTitle')}
                <InfoTip content={t('environmentsTip')} />
              </span>
            }
            action={
              <Link
                href={`/${workspace}/settings/environments`}
                className="text-[12.5px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('openEnvironments')}
              </Link>
            }
          />
          <div className="space-y-2">
            {environments.map((env) => (
              <EnvironmentContextCard key={`${env.id}@${env.version}`} env={env} />
            ))}
          </div>
        </section>
      )}

      {canPush && (
        <div className="flex justify-end border-t pt-4">
          <Button variant="outline" size="sm" onClick={unpublish} disabled={removing}>
            {removing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            {t('unpublish')}
          </Button>
        </div>
      )}
    </div>
  )
}

function EnvironmentContextCard({ env }: { env: ImageEnvironmentLink }) {
  const t = useTranslations('workspaceImages')
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-2 rounded-lg border bg-card px-3 py-2.5 shadow-raise">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-[560]">{env.name}</span>
        <Badge tone="outline">v{env.version}</Badge>
        {env.benchmark && <Badge tone="info">{env.benchmark}</Badge>}
        {env.os && env.arch && (
          <Badge tone="outline">
            {env.os}/{env.arch}
          </Badge>
        )}
        {env.packages.length > 0 && (
          <Badge tone="outline">{t('packageCount', { count: env.packages.length })}</Badge>
        )}
      </div>
      {env.description && <p className="text-[12.5px] text-muted-foreground">{env.description}</p>}
      {env.instructions && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {t('agentInstructions')}
          </button>
          {open && (
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <Markdown content={env.instructions} className="text-[12.5px]" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
