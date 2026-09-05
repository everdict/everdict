'use client'

import { useState, useTransition } from 'react'
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
import { Link } from '@/shared/ui/link'
import { Markdown } from '@/shared/ui/markdown'
import { SectionHeader } from '@/shared/ui/section-header'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  inspectWorkspaceImageAction,
  removeWorkspaceImageAction,
} from '../api/manage-workspace-images'

// The environment capability that DECLARED this repository — the "everdict-side context" the image detail shows. It is the UI face of the
// domain judgement that an environment image is bytes (the registry) plus agent context (instructions/contents) together.
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

// Turn an OCI history's created_by back into a Dockerfile statement: what follows "#(nop)" is the body of a metadata instruction, and
// "/bin/sh -c …" is a RUN wrapped in a shell. It tidies only as far as it can without harming the source (an unknown shape is left alone).
function dockerfileStep(createdBy: string): string {
  const nop = createdBy.match(/#\(nop\)\s+(.*)$/)
  if (nop?.[1]) return nop[1].trim()
  return createdBy.replace(/^\/bin\/sh -c\s+/, 'RUN ').trim()
}

// Settings › Images › detail — the grammar of a JFrog-style registry UI: versions (tags) first, then the chosen version's digest, size and
// platform, beneath that "how was this image built" (the OCI config history) and the runtime contract, and finally the everdict-side
// context (the environment that declared this image). The detail is a ROUTE — it is a screen used beside the conversation panel on the right.
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
  image: string // the ref with no tag — "<endpoint>/<namespace>/<name>"
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
  const [pending, setPending] = useState(false)
  const [removing, startRemoving] = useTransition()

  const inspect = selected ? (details[selected] ?? null) : null
  const selectedRef = selected ? `${image}:${selected}` : image

  const select = (tag: string) => {
    setSelected(tag)
    if (tag in details) return
    void (async () => {
      setPending(true)
      try {
        const res = await inspectWorkspaceImageAction(name, tag)
        // The row survives a failure — a null cache marks "the summary could not be read", and re-selecting does not retry.
        setDetails((prev) => ({ ...prev, [tag]: res.ok ? res.inspect : null }))
        if (!res.ok) setError(res.error)
      } finally {
        setPending(false)
      }
    })()
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
      {/* The meta strip — the chosen version's ref is what goes into a spec, so copying it has to be one click. */}
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

      {/* Versions come FIRST — the repository is a shell and what a user picks is a tag. */}
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

      {/* How it was built — the OCI config history turned back into Dockerfile statements. */}
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

      {/* The runtime contract — the promises made when the image runs. An empty entry is not rendered (the detail-view convention). */}
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

      {/* The everdict-side context — the environment capability that declared this image. It shows, on the detail, the domain judgement that an
          environment image is not bytes alone but the instructions the agent receives too. Absent, the whole section hides. */}
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
