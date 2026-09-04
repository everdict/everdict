'use client'

import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { ImagePlus, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'

import { mediaSnippet } from '../lib/insert'
import { uploadedMediaSchema } from '../model/schema'

// Pasting or dropping a file where writing happens uploads it to the workspace filesystem and inserts the syntax into the body.
// The issue description, comments and the sub-issue composer all use the same one — attaching has to be the SAME action on these screens.
//
// Inserting at the caret is NOT this component's job. The caller holds the textarea's value, and code touching both the value and the caret in
// two places will inevitably diverge — here only the syntax to insert is built and handed over.

// A mirror of the control plane's file limit (the same value as the route's) — for turning a file back before uploading.
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
  // dragenter/leave fire back and forth every time the pointer crosses a child — without counting depth the indicator flickers.
  const depth = useRef(0)

  async function accept(files: File[]) {
    if (disabled || files.length === 0) return
    setError(undefined)
    // Uploaded ONE at a time — the order they were dropped in has to be the order they are pinned into the body.
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
    // Intercepted only when files are carried — an ordinary text paste has to pass straight through.
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
        // Without preventing this the browser OPENS the file and the whole page is replaced.
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
