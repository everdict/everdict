'use client'

import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { ImagePlus, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'

import { mediaSnippet } from '../lib/insert'
import { uploadedMediaSchema } from '../model/schema'

// 글 쓰는 자리에 파일을 붙여넣거나 끌어다 놓으면 워크스페이스 파일시스템에 올리고 본문에 문법을 끼워 넣는다.
// 이슈 설명·코멘트·하위 이슈 작성기가 같은 것을 쓴다 — 첨부는 이 화면들에서 같은 동작이어야 한다.
//
// 커서 자리에 넣는 일은 이 컴포넌트가 하지 않는다. 텍스트영역의 값을 쥐고 있는 것은 부르는 쪽이고, 값과 커서를
// 둘 다 만지는 코드가 두 곳에 있으면 반드시 어긋난다 — 여기서는 넣을 문법만 만들어 넘긴다.

// 제어 평면의 파일 한도 거울(라우트의 것과 같은 값) — 올리기 전에 돌려보내기 위한 것.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

export function MediaDropZone({
  onInsert,
  disabled = false,
  className,
  children,
}: {
  onInsert: (snippet: string) => void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  const t = useTranslations('attachMedia')
  const [uploading, setUploading] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const [dragging, setDragging] = useState(false)
  // dragenter/leave 는 자식 위를 지날 때마다 오간다 — 깊이를 세지 않으면 표시가 깜빡인다.
  const depth = useRef(0)

  async function accept(files: File[]) {
    if (disabled || files.length === 0) return
    setError(undefined)
    // 한 번에 한 개씩 올린다 — 놓은 순서가 곧 본문에 박히는 순서여야 한다.
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(t('tooLarge', { name: file.name }))
        continue
      }
      setUploading((names) => [...names, file.name])
      try {
        const body = new FormData()
        body.append('file', file)
        const res = await fetch('/api/fs/uploads', { method: 'POST', body })
        const payload: unknown = await res.json().catch(() => undefined)
        if (!res.ok) {
          const message = (payload as { error?: unknown } | undefined)?.error
          setError(
            res.status === 413
              ? t('tooLarge', { name: file.name })
              : t('failed', {
                  reason: typeof message === 'string' ? message : `HTTP ${res.status}`,
                })
          )
          continue
        }
        const uploaded = uploadedMediaSchema.parse(payload)
        onInsert(mediaSnippet(uploaded.kind, uploaded.name, uploaded.url))
      } catch (e) {
        setError(t('failed', { reason: e instanceof Error ? e.message : String(e) }))
      } finally {
        setUploading((names) => names.filter((n) => n !== file.name))
      }
    }
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(e.clipboardData.files)
    // 파일이 실려 있을 때만 가로챈다 — 평범한 글 붙여넣기는 그대로 지나가야 한다.
    if (files.length === 0) return
    e.preventDefault()
    void accept(files)
  }

  function carriesFiles(e: DragEvent<HTMLDivElement>): boolean {
    return Array.from(e.dataTransfer.types).includes('Files')
  }

  return (
    <div
      className={cn('relative', className)}
      onPaste={onPaste}
      onDragEnter={(e) => {
        if (disabled || !carriesFiles(e)) return
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        // 이걸 막지 않으면 브라우저가 파일을 열어 버려 페이지가 통째로 바뀐다.
        if (!disabled && carriesFiles(e)) e.preventDefault()
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        if (disabled || !carriesFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setDragging(false)
        void accept(Array.from(e.dataTransfer.files))
      }}
    >
      {children}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary/60 bg-primary/8 text-[12.5px] font-[510] text-primary backdrop-blur-[1px]">
          <ImagePlus className="size-4" />
          {t('dropHint')}
        </div>
      )}

      {uploading.length > 0 && (
        <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t('uploading', { name: uploading[0] ?? '' })}
        </p>
      )}
      {error !== undefined && (
        <Callout tone="danger" className="mt-1.5 py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
