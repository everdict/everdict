import type { ComponentType } from 'react'
import { Cog, ExternalLink, Globe, Terminal, Timer } from 'lucide-react'

import { cn } from '@/shared/lib/utils'

// 스코어카드 트리거 출처(provenance) — 컨트롤플레인 ScorecardOrigin 과 동형(구조적). shared 는 최하위 레이어라
// entities 를 import 하지 않으므로 여기서 표시에 필요한 모양만 로컬로 미러한다.
export interface OriginLike {
  source: string // github-actions | schedule | api | web …
  repo?: string // "owner/name"
  sha?: string
  ref?: string // refs/heads/… | refs/pull/…
  prNumber?: number
  runUrl?: string // CI run 링크
  pinOverrides?: Record<string, string> // 제출 시점 임시 핀(슬롯→이미지)
}

// source → 한국어 라벨 + 아이콘. 미지정 source 는 원문 그대로.
const SOURCE_META: Record<string, { label: string; icon: ComponentType<{ className?: string }> }> =
  {
    'github-actions': { label: 'CI', icon: Cog },
    schedule: { label: '예약', icon: Timer },
    web: { label: '웹', icon: Globe },
    api: { label: 'API', icon: Terminal },
  }
function sourceMeta(source: string) {
  return SOURCE_META[source] ?? { label: source, icon: Cog }
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

// 컴팩트 출처 칩(목록용) — 링크 없음(행 전체가 이미 <a> 라 앵커 중첩 금지). 소스 라벨 + 커밋/PR 은 평문으로.
export function OriginChip({ origin, className }: { origin: OriginLike; className?: string }) {
  const meta = sourceMeta(origin.source)
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground',
        className
      )}
    >
      <Icon className="size-3 text-muted-foreground/70" />
      <span className="font-[560] text-foreground/85">{meta.label}</span>
      {origin.repo && origin.sha && (
        <span className="truncate text-faint">
          · {origin.repo}@{shortSha(origin.sha)}
        </span>
      )}
      {origin.prNumber != null && <span className="text-faint">· #{origin.prNumber}</span>}
    </span>
  )
}

// 전체 출처 블록(상세용) — 커밋/PR/CI run 링크 + 임시 핀(pinOverrides) 표. 여기선 앵커를 써도 된다.
export function OriginBlock({ origin }: { origin: OriginLike }) {
  const meta = sourceMeta(origin.source)
  const Icon = meta.icon
  const commitUrl =
    origin.repo && origin.sha ? `https://github.com/${origin.repo}/commit/${origin.sha}` : undefined
  const prUrl =
    origin.repo && origin.prNumber != null
      ? `https://github.com/${origin.repo}/pull/${origin.prNumber}`
      : undefined
  const pins = Object.entries(origin.pinOverrides ?? {})

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-1.5">
          <Icon className="size-3.5 text-muted-foreground/70" />
          <span className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">출처</span>
          <span className="text-[13px] font-[510] text-foreground">{meta.label}</span>
        </span>
        {commitUrl ? (
          <a
            href={commitUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[12px] text-link transition-colors hover:text-foreground"
          >
            {origin.repo}@{origin.sha && shortSha(origin.sha)}
            <ExternalLink className="size-3" />
          </a>
        ) : (
          origin.repo && (
            <span className="font-mono text-[12px] text-muted-foreground">{origin.repo}</span>
          )
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[12px] text-link transition-colors hover:text-foreground"
          >
            #{origin.prNumber}
            <ExternalLink className="size-3" />
          </a>
        )}
        {origin.ref && <span className="font-mono text-[11px] text-faint">{origin.ref}</span>}
        {origin.runUrl && (
          <a
            href={origin.runUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-link transition-colors hover:text-foreground"
          >
            CI run
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {pins.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
            임시 핀 (슬롯 → 이미지)
          </p>
          <div className="divide-y divide-border/70 overflow-hidden rounded-md border">
            {pins.map(([slot, image]) => (
              <div key={slot} className="flex items-center gap-3 px-3 py-1.5">
                <span className="shrink-0 font-mono text-[12px] font-[510] text-foreground">
                  {slot}
                </span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">
                  {image}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
