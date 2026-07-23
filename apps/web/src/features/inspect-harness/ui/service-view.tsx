import { Boxes, Database, DoorOpen, Globe, Radio } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { envValueText, type HarnessSpec } from '@/entities/harness'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'

import { Field, ImageClassBadge, Mono, SubSection } from './parts'

// service (topology) harness config — the text counterpart of the diagram. front-door/services/dependencies/target/trace.
// The provenance-classification badge reads the served spec.imageClasses (P1g) — no client-side classification.
export function ServiceView({ spec }: { spec: HarnessSpec }) {
  const t = useTranslations('inspectHarness')
  const services = spec.services ?? []
  const deps = spec.dependencies ?? []
  const target = spec.target
  const traceSource = spec.traceSource
  const frontDoor = spec.frontDoor
  // The delivery mode must be one of reference|sentinel|egress (the control-plane contract). The served spec is a loose
  // display view, so an out-of-contract value still renders — flag it: it's the shape that fails at the runner boundary
  // (a "malformed job"), most often a control-plane/runner version skew.
  const deliveryUnknownMode =
    target?.delivery !== undefined &&
    !['reference', 'sentinel', 'egress'].includes(target.delivery.mode)

  return (
    <div className="space-y-7">
      {frontDoor && (
        <SubSection title="Front door" icon={<DoorOpen className="size-4" />}>
          <Card>
            <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
              <Field label={t('service')} value={frontDoor.service} />
              <Field label={t('submit')} value={<Mono>{frontDoor.submit}</Mono>} mono={false} />
              {frontDoor.trace && <Field label={t('trace')} value={frontDoor.trace} />}
            </dl>
          </Card>
        </SubSection>
      )}

      <SubSection title="Services" icon={<Boxes className="size-4" />} count={services.length}>
        <div className="space-y-2">
          {services.map((s) => (
            <Card key={s.name} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-[560] text-foreground">{s.name}</span>
                  {s.name === frontDoor?.service && <Badge tone="info">front door</Badge>}
                </div>
                <div className="flex items-center gap-1.5">
                  {/* Intrinsic OS placement — shown only when non-linux (linux is the default, no node gate). */}
                  {s.requires?.os && s.requires.os !== 'linux' && (
                    <Badge tone="outline" title={t('serviceOsNodeTip', { os: s.requires.os })}>
                      {s.requires.os}
                    </Badge>
                  )}
                  {s.port !== undefined && <Mono>:{s.port}</Mono>}
                  <Mono>×{s.replicas}</Mono>
                </div>
              </div>
              {s.image && (
                <div className="mt-2 flex min-w-0 items-center gap-2">
                  <span
                    className="truncate font-mono text-[12px] text-muted-foreground"
                    title={s.image}
                  >
                    {s.image}
                  </span>
                  <ImageClassBadge
                    cls={spec.imageClasses?.find((x) => x.image === s.image)?.class}
                  />
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-4">
                <ChipList label="needs" items={s.needs} empty="—" />
                <ChipList label="per-run keys" items={s.perRun} empty="—" />
              </div>
              {Object.keys(s.env ?? {}).length > 0 && (
                <div className="mt-3">
                  <div className="text-[10.5px] font-[510] uppercase tracking-wide text-faint">
                    env
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {Object.entries(s.env).map(([k, val]) => (
                      <code
                        key={k}
                        title={`${k}=${envValueText(val, t('secretLabel'))}`}
                        className="max-w-full truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border"
                      >
                        {k}=
                        <span className="text-foreground/80">
                          {envValueText(val, t('secretLabel'))}
                        </span>
                      </code>
                    ))}
                  </div>
                </div>
              )}
              {s.volumes && s.volumes.length > 0 && (
                <div className="mt-3">
                  <ChipList label="volumes" items={s.volumes} empty="—" />
                </div>
              )}
              {s.readiness && (
                <div className="mt-3">
                  <div className="text-[10.5px] font-[510] uppercase tracking-wide text-faint">
                    readiness
                  </div>
                  <div className="mt-1 font-mono text-[12px] text-muted-foreground">
                    timeout {s.readiness.timeoutMs}ms · interval {s.readiness.intervalMs}ms
                  </div>
                </div>
              )}
            </Card>
          ))}
          {services.length === 0 && (
            <p className="text-[13px] text-muted-foreground">{t('noServices')}</p>
          )}
        </div>
      </SubSection>

      <SubSection title="Dependencies" icon={<Database className="size-4" />} count={deps.length}>
        {deps.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('noSharedStores')}</p>
        ) : (
          <Card className="divide-y divide-border">
            {deps.map((d, i) => {
              const external = d.isolateBy === 'external'
              const inject = d.inject ?? []
              return (
                <div key={i} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="text-[13px] font-[560] text-foreground">{d.store}</span>
                      <span className="font-mono text-[12px] text-muted-foreground">{d.role}</span>
                      {d.service && (
                        <span className="text-[12px] text-faint">used by {d.service}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {d.purpose === 'data' && <Badge tone="info">{t('depDataBadge')}</Badge>}
                      {external ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-faint">{t('connEnvAtDeploy')}</span>
                          <Badge tone="warning">external (BYO)</Badge>
                        </div>
                      ) : (
                        <Badge tone="outline">isolate · {d.isolateBy}</Badge>
                      )}
                    </div>
                  </div>
                  {/* BYO env keys the image reads — rendered from the deployed store at deploy time (dependencies[].inject). */}
                  {inject.length > 0 && (
                    <div className="space-y-0.5">
                      <span className="text-[11px] text-faint">{t('depInjectHeading')}</span>
                      {inject.map((m, j) => (
                        <div key={j} className="font-mono text-[12px] text-muted-foreground">
                          <span className="text-foreground">{m.env}</span>
                          {' ← '}
                          {m.template ?? '{url}'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </Card>
        )}
      </SubSection>

      {target && (
        <SubSection title="Target env" icon={<Globe className="size-4" />}>
          <Card>
            <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
              <Field label={t('kind')} value={target.kind} />
              {target.engine && <Field label={t('engine')} value={target.engine} />}
              {target.lifecycle && <Field label={t('lifecycle')} value={target.lifecycle} />}
              {target.extension && <Field label={t('extension')} value={target.extension.ref} />}
              <Field
                label={t('deliveryLabel')}
                mono={false}
                value={
                  target.delivery ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[12.5px]">
                        {target.delivery.mode +
                          (target.delivery.path ? ` (${target.delivery.path})` : '') +
                          (target.delivery.sink ? ` → ${target.delivery.sink}` : '')}
                      </span>
                      {deliveryUnknownMode && (
                        <Badge tone="warning">{t('deliveryUnknownMode')}</Badge>
                      )}
                    </span>
                  ) : (
                    'reference (store-fetch)'
                  )
                }
              />
            </dl>
            {target.observe.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3">
                <span className="mr-1 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
                  observe
                </span>
                {target.observe.map((o) => (
                  <Mono key={o}>{o}</Mono>
                ))}
              </div>
            )}
          </Card>
        </SubSection>
      )}

      {traceSource && (
        <SubSection title="Trace source" icon={<Radio className="size-4" />}>
          <Card>
            <dl className="grid grid-cols-2 gap-4 p-4">
              <Field label={t('kind')} value={traceSource.kind} />
              <Field label={t('endpoint')} value={traceSource.endpoint} />
            </dl>
          </Card>
        </SubSection>
      )}
    </div>
  )
}

function ChipList({ label, items, empty }: { label: string; items: string[]; empty: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-[510] uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {items.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">{empty}</span>
        ) : (
          items.map((it) => (
            <code
              key={it}
              className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border"
            >
              {it}
            </code>
          ))
        )}
      </div>
    </div>
  )
}
