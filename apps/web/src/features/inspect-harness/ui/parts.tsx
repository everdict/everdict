import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'

import { classifyImageRef, type ImageRegistryCoordinates } from '@/shared/lib/image-ref'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

// Shared primitives for the inspect-harness views — label/value field, mono chip, labeled section.

// Image provenance badge — workspace registry (blue) / local-only·unqualified (warning). external is the default state, so no badge (noise avoidance).
// The hint is on title (same convention as the image ref, which already uses title). The classification SSOT is the control plane; this is a display-only mirror.
export function ImageClassBadge({
  image,
  registry,
}: {
  image: string
  registry?: ImageRegistryCoordinates | ImageRegistryCoordinates[] // multiple registries — a match on any one means workspace
}) {
  const t = useTranslations('lib')
  const cls = classifyImageRef(image, registry)
  if (cls === 'external') return null
  // Turn the classification value (workspace/local/unqualified) into a catalog-key suffix: imageClass*/imageHint*.
  const suffix = cls.charAt(0).toUpperCase() + cls.slice(1)
  return (
    <Badge tone={cls === 'workspace' ? 'info' : 'warning'} title={t(`imageHint${suffix}`)}>
      {t(`imageClass${suffix}`)}
    </Badge>
  )
}

export function Field({
  label,
  value,
  mono = true,
  className,
}: {
  label: ReactNode
  value: ReactNode
  mono?: boolean
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[10.5px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd
        className={cn(
          'mt-1 truncate text-[13px] text-foreground',
          mono && 'font-mono text-[12.5px]'
        )}
      >
        {value}
      </dd>
    </div>
  )
}

// One row of label (narrow left column) + value (fill) — a responsive grid cell. wide=full width (long values like a command). The grid gap handles padding.
export function DefRow({
  label,
  children,
  mono = false,
  wide = false,
}: {
  label: ReactNode
  children: ReactNode
  mono?: boolean
  wide?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4',
        wide && 'col-span-full'
      )}
    >
      <span className="shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint sm:w-20">
        {label}
      </span>
      <div
        className={cn(
          'min-w-0 flex-1 text-[13px] text-foreground',
          mono && 'break-all font-mono text-[12.5px]'
        )}
      >
        {children}
      </div>
    </div>
  )
}

// Split out and highlight the {{task}}/{{model}}/{{run_id}} placeholders in a command template (pure). Used by the command view.
export function highlightTemplate(command: string): ReactNode[] {
  return command.split(/(\{\{[^}]+\}\})/g).map((part, i) =>
    /^\{\{[^}]+\}\}$/.test(part) ? (
      <span
        key={i}
        className="rounded bg-primary/15 px-1 text-[var(--color-accent-foreground)] ring-1 ring-inset ring-primary/25"
      >
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    )
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'rounded bg-secondary px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground ring-1 ring-inset ring-border',
        className
      )}
    >
      {children}
    </code>
  )
}

export function SubSection({
  title,
  icon,
  count,
  children,
}: {
  title: ReactNode
  icon?: ReactNode
  count?: number
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <h3 className="text-[13px] font-[560] tracking-[-0.01em] text-foreground">{title}</h3>
        {count !== undefined && (
          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10.5px] font-[510] tabular-nums text-muted-foreground ring-1 ring-inset ring-border">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}
