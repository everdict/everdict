'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Boxes, Database, DoorOpen, Globe, Layers, Radio } from 'lucide-react'

import type { HarnessSpec, TopologyDependency, TopologyService } from '@/entities/harness'
import { cn } from '@/shared/lib/utils'

// 서비스(토폴로지) 하니스의 인프라 관계를 측정 기반 SVG 도식으로 그린다.
// 레인: Ingress(프론트도어) → Agent topology(서비스 + needs 엣지) → State & world(스토어 + 타깃).
// 트레이스 출처는 out-of-band(에이전트가 내보내고 평가가 끌어옴). 좌표는 실제 노드 위치를 측정해 반응형으로 재계산.

type Side = 'left' | 'right'
type EdgeKind = 'submit' | 'needs' | 'store' | 'target' | 'trace'

interface RawEdge {
  id: string
  from: string
  to: string
  kind: EdgeKind
  label?: string
}
interface DrawnEdge extends RawEdge {
  d: string
  lx: number
  ly: number
}

const EDGE_STROKE: Record<EdgeKind, string> = {
  submit: 'var(--color-primary)',
  needs: 'var(--color-muted-foreground)',
  store: 'var(--color-link)',
  target: 'var(--color-accent-foreground)',
  trace: 'var(--color-faint)',
}
const EDGE_DASH: Partial<Record<EdgeKind, string>> = {
  needs: '5 4',
  trace: '2 5',
}

// store 종류별 색 — 시각적으로 구분(스키마 무관 문자열이므로 폴백 indigo).
const STORE_COLOR: Record<string, string> = {
  postgres: '#4c8dff',
  redis: '#ef6f6c',
  minio: '#3fc8a0',
}
function storeColor(store: string): string {
  return STORE_COLOR[store] ?? 'var(--color-link)'
}

function anchor(container: DOMRect, el: HTMLElement, side: Side): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return {
    x: (side === 'left' ? r.left : r.right) - container.left,
    y: r.top - container.top + r.height / 2,
  }
}

function pathFor(
  p0: { x: number; y: number },
  s0: Side,
  p1: { x: number; y: number },
  s1: Side
): { d: string; lx: number; ly: number } {
  // 같은 레인 내 needs 엣지(좌→좌): 왼쪽 거터로 휘어지는 브래킷.
  if (s0 === 'left' && s1 === 'left') {
    const g = 26
    const x = Math.min(p0.x, p1.x) - g
    return {
      d: `M ${p0.x},${p0.y} C ${x},${p0.y} ${x},${p1.y} ${p1.x},${p1.y}`,
      lx: x,
      ly: (p0.y + p1.y) / 2,
    }
  }
  // 레인 횡단(우→좌): 수평 큐빅 베지어.
  const dx = Math.max(48, p1.x - p0.x)
  const c0x = p0.x + dx * 0.5
  const c1x = p1.x - dx * 0.5
  return {
    d: `M ${p0.x},${p0.y} C ${c0x},${p0.y} ${c1x},${p1.y} ${p1.x},${p1.y}`,
    lx: (p0.x + p1.x) / 2,
    ly: (p0.y + p1.y) / 2,
  }
}

function buildEdges(
  services: TopologyService[],
  deps: TopologyDependency[],
  frontDoorService: string,
  frontDoorSubmit: string,
  hasTarget: boolean,
  traceLabel: string | null
): RawEdge[] {
  const names = new Set(services.map((s) => s.name))
  const anchorId = names.has(frontDoorService) ? `svc:${frontDoorService}` : 'ingress'
  const edges: RawEdge[] = [
    {
      id: 'submit',
      from: 'ingress',
      to: `svc:${frontDoorService}`,
      kind: 'submit',
      label: frontDoorSubmit,
    },
  ]
  for (const s of services)
    for (const need of s.needs)
      if (names.has(need))
        edges.push({
          id: `needs:${s.name}->${need}`,
          from: `svc:${s.name}`,
          to: `svc:${need}`,
          kind: 'needs',
          label: 'needs',
        })
  deps.forEach((d, i) =>
    edges.push({
      id: `store:${i}`,
      from: anchorId,
      to: `store:${i}`,
      kind: 'store',
      label: d.isolateBy,
    })
  )
  if (hasTarget)
    edges.push({ id: 'target', from: anchorId, to: 'target', kind: 'target', label: 'acts on' })
  if (traceLabel)
    edges.push({ id: 'trace', from: anchorId, to: 'trace', kind: 'trace', label: traceLabel })
  return edges
}

export function TopologyGraph({ spec }: { spec: HarnessSpec }) {
  const services = spec.services ?? []
  const deps = spec.dependencies ?? []
  const target = spec.target
  const traceSource = spec.traceSource
  const frontDoor = spec.frontDoor

  const frontDoorService = frontDoor?.service ?? services[0]?.name ?? ''
  const frontDoorSubmit = frontDoor?.submit ?? 'submit'
  const traceLabel = traceSource ? traceSource.kind : null

  const containerRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map())
  const [edges, setEdges] = useState<DrawnEdge[]>([])
  const [hover, setHover] = useState<string | null>(null)

  const setNodeRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) nodeRefs.current.set(id, el)
      else nodeRefs.current.delete(id)
    },
    []
  )

  const compute = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const cr = container.getBoundingClientRect()
    const raw = buildEdges(services, deps, frontDoorService, frontDoorSubmit, !!target, traceLabel)
    const drawn: DrawnEdge[] = []
    for (const e of raw) {
      const a = nodeRefs.current.get(e.from)
      const b = nodeRefs.current.get(e.to)
      if (!a || !b) continue
      const [s0, s1]: [Side, Side] = e.kind === 'needs' ? ['left', 'left'] : ['right', 'left']
      const p0 = anchor(cr, a, s0)
      const p1 = anchor(cr, b, s1)
      drawn.push({ ...e, ...pathFor(p0, s0, p1, s1) })
    }
    setEdges(drawn)
  }, [spec])

  useLayoutEffect(() => {
    compute()
  }, [compute])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => compute())
    ro.observe(container)
    window.addEventListener('resize', compute)
    // 폰트 로드 후 메트릭이 바뀌면 한 번 더(레이아웃 시프트 보정).
    const t = setTimeout(compute, 220)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', compute)
      clearTimeout(t)
    }
  }, [compute])

  const dim = (edge: RawEdge): boolean => hover !== null && hover !== edge.from && hover !== edge.to
  const nodeDim = (id: string): boolean =>
    hover !== null &&
    hover !== id &&
    !edges.some((e) => (e.from === hover && e.to === id) || (e.to === hover && e.from === id))

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-[var(--color-muted)]/40 [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:22px_22px]">
      <div ref={containerRef} className="relative min-w-[700px] p-6">
        {/* 엣지 레이어 */}
        <svg
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
          aria-hidden
        >
          <defs>
            <marker
              id="harness-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
          </defs>
          {edges.map((e) => (
            <path
              key={e.id}
              d={e.d}
              fill="none"
              stroke={EDGE_STROKE[e.kind]}
              strokeWidth={e.kind === 'submit' ? 2 : 1.5}
              strokeDasharray={EDGE_DASH[e.kind]}
              markerEnd="url(#harness-arrow)"
              className="transition-opacity duration-200"
              style={{ opacity: dim(e) ? 0.12 : 0.9 }}
            />
          ))}
        </svg>

        {/* 엣지 라벨 레이어 */}
        <div className="pointer-events-none absolute inset-0 z-[5]">
          {edges
            .filter((e) => e.label)
            .map((e) => (
              <span
                key={e.id}
                className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border bg-card/90 px-1.5 py-px font-mono text-[10px] leading-none text-muted-foreground shadow-raise backdrop-blur transition-opacity duration-200"
                style={{ left: e.lx, top: e.ly, opacity: dim(e) ? 0.1 : 1 }}
              >
                {e.label}
              </span>
            ))}
        </div>

        {/* 노드 레인 */}
        <div className="relative z-10 grid grid-cols-[minmax(0,0.82fr)_minmax(0,1.25fr)_minmax(0,1fr)] gap-x-12">
          <Lane label="Ingress">
            <Node
              ref={setNodeRef('ingress')}
              role="ingress"
              dim={nodeDim('ingress')}
              onHover={() => setHover('ingress')}
              onLeave={() => setHover(null)}
              icon={<DoorOpen className="size-3.5" />}
              title="Front door"
            >
              <div className="mt-1 truncate font-mono text-[11px] text-foreground">
                {frontDoorService}
              </div>
              <code className="mt-1.5 inline-block rounded bg-primary/12 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-accent-foreground)] ring-1 ring-inset ring-primary/20">
                {frontDoorSubmit}
              </code>
            </Node>
          </Lane>

          <Lane label="Agent topology">
            {services.map((s) => (
              <Node
                key={s.name}
                ref={setNodeRef(`svc:${s.name}`)}
                role="service"
                accent={s.name === frontDoorService}
                dim={nodeDim(`svc:${s.name}`)}
                onHover={() => setHover(`svc:${s.name}`)}
                onLeave={() => setHover(null)}
                icon={<Boxes className="size-3.5" />}
                title={s.name}
                badges={
                  <>
                    {s.port !== undefined && <NodeBadge>:{s.port}</NodeBadge>}
                    {s.replicas > 1 && <NodeBadge>×{s.replicas}</NodeBadge>}
                  </>
                }
              >
                {s.image && (
                  <div
                    className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                    title={s.image}
                  >
                    {s.image}
                  </div>
                )}
                {s.perRun.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {s.perRun.map((k) => (
                      <span
                        key={k}
                        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[9.5px] leading-none text-muted-foreground ring-1 ring-inset ring-border"
                        title="per-run 주입 키"
                      >
                        {k}
                      </span>
                    ))}
                  </div>
                )}
              </Node>
            ))}
            {services.length === 0 && (
              <p className="text-[12px] text-muted-foreground">서비스 없음</p>
            )}
          </Lane>

          <Lane label="State & world">
            {deps.map((d, i) => (
              <Node
                key={`store:${i}`}
                ref={setNodeRef(`store:${i}`)}
                role="store"
                dim={nodeDim(`store:${i}`)}
                onHover={() => setHover(`store:${i}`)}
                onLeave={() => setHover(null)}
                icon={<Database className="size-3.5" />}
                dot={storeColor(d.store)}
                title={d.store}
                badges={<NodeBadge>{d.isolateBy}</NodeBadge>}
              >
                <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                  {d.role}
                </div>
              </Node>
            ))}
            {target && (
              <Node
                ref={setNodeRef('target')}
                role="target"
                dim={nodeDim('target')}
                onHover={() => setHover('target')}
                onLeave={() => setHover(null)}
                icon={<Globe className="size-3.5" />}
                title={`target · ${target.kind}`}
                badges={target.engine ? <NodeBadge>{target.engine}</NodeBadge> : null}
              >
                {target.lifecycle && (
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {target.lifecycle}
                  </div>
                )}
                {target.observe.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {target.observe.map((o) => (
                      <span
                        key={o}
                        className="rounded bg-[var(--color-accent)] px-1.5 py-0.5 font-mono text-[9.5px] leading-none text-[var(--color-accent-foreground)]"
                      >
                        {o}
                      </span>
                    ))}
                  </div>
                )}
              </Node>
            )}
            {traceSource && (
              <Node
                ref={setNodeRef('trace')}
                role="trace"
                dim={nodeDim('trace')}
                onHover={() => setHover('trace')}
                onLeave={() => setHover(null)}
                icon={<Radio className="size-3.5" />}
                title={`trace · ${traceSource.kind}`}
              >
                <div
                  className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                  title={traceSource.endpoint}
                >
                  {traceSource.endpoint}
                </div>
              </Node>
            )}
            {deps.length === 0 && !target && !traceSource && (
              <p className="text-[12px] text-muted-foreground">의존 인프라 없음</p>
            )}
          </Lane>
        </div>
      </div>

      <Legend />
    </div>
  )
}

function Lane({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-[10px] font-[560] uppercase tracking-[0.14em] text-faint">
        <Layers className="size-3" />
        {label}
      </div>
      {children}
    </div>
  )
}

const ROLE_RAIL: Record<string, string> = {
  ingress: 'before:bg-[var(--color-primary)]',
  service: 'before:bg-[var(--color-link)]',
  store: 'before:bg-[var(--color-warning)]',
  target: 'before:bg-[var(--color-accent-foreground)]',
  trace: 'before:bg-faint',
}

const Node = function Node({
  ref,
  role,
  title,
  icon,
  badges,
  children,
  accent,
  dot,
  dim,
  onHover,
  onLeave,
}: {
  ref: (el: HTMLElement | null) => void
  role: 'ingress' | 'service' | 'store' | 'target' | 'trace'
  title: string
  icon: React.ReactNode
  badges?: React.ReactNode
  children?: React.ReactNode
  accent?: boolean
  dot?: string
  dim: boolean
  onHover: () => void
  onLeave: () => void
}) {
  return (
    <div
      ref={ref}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className={cn(
        'group relative overflow-hidden rounded-lg border bg-card px-3 py-2.5 shadow-raise transition-all duration-200',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[""]',
        ROLE_RAIL[role],
        accent ? 'border-primary/40 ring-1 ring-primary/15' : 'border-border',
        dim ? 'opacity-35' : 'opacity-100 hover:border-border-strong'
      )}
    >
      <div className="flex items-center gap-2 pl-1.5">
        <span className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground">
          {dot ? <span className="size-2 rounded-full" style={{ background: dot }} /> : icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-[560] text-foreground">
          {title}
        </span>
        {badges && <span className="flex shrink-0 items-center gap-1">{badges}</span>}
      </div>
      {children && <div className="pl-1.5">{children}</div>}
    </div>
  )
}

function NodeBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-secondary px-1 py-0.5 font-mono text-[9.5px] leading-none text-muted-foreground ring-1 ring-inset ring-border">
      {children}
    </span>
  )
}

function Legend() {
  const items: Array<{ kind: EdgeKind; label: string }> = [
    { kind: 'submit', label: '제출' },
    { kind: 'needs', label: 'needs' },
    { kind: 'store', label: '스토어' },
    { kind: 'target', label: '타깃' },
    { kind: 'trace', label: '트레이스(pull)' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border px-6 py-2.5">
      {items.map((it) => (
        <div
          key={it.kind}
          className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground"
        >
          <svg width="20" height="8" aria-hidden>
            <line
              x1="1"
              y1="4"
              x2="19"
              y2="4"
              stroke={EDGE_STROKE[it.kind]}
              strokeWidth="2"
              strokeDasharray={EDGE_DASH[it.kind]}
            />
          </svg>
          {it.label}
        </div>
      ))}
    </div>
  )
}
