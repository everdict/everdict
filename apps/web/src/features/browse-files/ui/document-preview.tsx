'use client'

import { useEffect, useMemo, useState } from 'react'
import { FileArchive, FileQuestion, FileText } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FsFileContentView } from '@/entities/workspace-file'
import { fmtBytes } from '@/shared/lib/format'
import { CodeEditor } from '@/shared/ui/code-editor'
import { EmptyState } from '@/shared/ui/empty-state'
import { Markdown } from '@/shared/ui/markdown'

import { parseDelimited, separatorFor } from '../lib/delimited-text'
import { fileBlob } from '../lib/file-bytes'
import { languageFor, previewKindFor, type FilePreviewKind } from '../lib/file-kind'

// The rendered body of one file — everything the viewer knows about showing a document, in one place. The
// viewer above it owns the chrome (path, edit, history, download); this owns the answer to "what IS this file".
// Adding a format means adding a branch HERE and a type to the contracts registry, nowhere else.
export function DocumentPreview({
  file,
  path,
  raw,
}: {
  file: FsFileContentView
  path: string
  raw: boolean // the header's Raw toggle — show the source instead of the rendered form
}) {
  const kind = previewKindFor(path, file.entry.contentType, file.encoding)
  if (raw && file.encoding === 'utf8') return <SourceView file={file} path={path} />

  switch (kind) {
    case 'markdown':
      return <Markdown content={file.content} className="max-w-none" />
    case 'table':
      return <TablePreview text={file.content} path={path} />
    case 'image':
    case 'pdf':
    case 'audio':
    case 'video':
      return <MediaPreview file={file} kind={kind} />
    case 'code':
      return <SourceView file={file} path={path} />
    default:
      return <OpaquePreview file={file} kind={kind} />
  }
}

function SourceView({ file, path }: { file: FsFileContentView; path: string }) {
  return (
    <CodeEditor
      value={file.content}
      language={languageFor(path)}
      minHeight="320px"
      readOnly
      aria-label={path}
    />
  )
}

// A blob URL, not a data: URI — a 5 MiB payload stays out of the DOM and the browser can stream/seek it, which
// is what makes <video> and the PDF <object> behave. Revoked when the file changes or the preview unmounts.
function useFileObjectUrl(file: FsFileContentView): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    const next = URL.createObjectURL(fileBlob(file.content, file.encoding, file.entry.contentType))
    setUrl(next)
    return () => {
      setUrl(undefined)
      URL.revokeObjectURL(next)
    }
  }, [file])
  return url
}

function MediaPreview({
  file,
  kind,
}: {
  file: FsFileContentView
  kind: Extract<FilePreviewKind, 'image' | 'pdf' | 'audio' | 'video'>
}) {
  const t = useTranslations('files')
  const url = useFileObjectUrl(file)
  if (url === undefined) return null

  if (kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- blob: source, no next/image optimisation to gain
      <img
        src={url}
        alt={file.entry.name}
        className="max-h-[480px] max-w-full rounded-md border border-border"
      />
    )
  }
  // No <track> on either player: this is user-supplied media, so there is no caption source to attach.
  if (kind === 'audio') {
    return <audio src={url} controls className="w-full" />
  }
  if (kind === 'video') {
    return (
      <video
        src={url}
        controls
        className="max-h-[480px] w-full rounded-md border border-border bg-black"
      />
    )
  }
  return (
    <object
      data={url}
      type="application/pdf"
      aria-label={file.entry.name}
      className="h-[70vh] min-h-[420px] w-full rounded-md border border-border"
    >
      <EmptyState title={t('previewUnavailable')} hint={t('previewUnavailableHint')} />
    </object>
  )
}

function TablePreview({ text, path }: { text: string; path: string }) {
  const t = useTranslations('files')
  const table = useMemo(() => parseDelimited(text, separatorFor(path)), [text, path])
  const [header, ...body] = table.rows
  if (header === undefined) return <EmptyState title={t('tableEmpty')} />

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-elevated">
              {header.map((cell, index) => (
                <th
                  key={index}
                  className="whitespace-nowrap border-b border-border px-2.5 py-1.5 text-left font-[510] text-foreground"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border/60 last:border-0">
                {header.map((_, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="whitespace-nowrap px-2.5 py-1.5 text-muted-foreground"
                  >
                    {row[cellIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11.5px] text-muted-foreground">
        {table.truncated
          ? t('tableTruncated', { rows: body.length })
          : t('tableRows', { rows: body.length })}
      </p>
    </div>
  )
}

// Office documents, archives and opaque blobs. They are NOT errors and NOT the same thing: an .xlsx is a
// deliverable someone can open the moment they have it, so the state names what it is and the header's download
// hands it over. Rendering these inline is the next step, not a missing one — see docs/architecture.
function OpaquePreview({
  file,
  kind,
}: {
  file: FsFileContentView
  kind: Extract<FilePreviewKind, 'document' | 'archive' | 'binary'>
}) {
  const t = useTranslations('files')
  const title =
    kind === 'document'
      ? t('documentFile')
      : kind === 'archive'
        ? t('archiveFile')
        : t('binaryFile')
  const icon =
    kind === 'document' ? <FileText /> : kind === 'archive' ? <FileArchive /> : <FileQuestion />
  const size = file.entry.size !== undefined ? fmtBytes(file.entry.size) : undefined
  const hint =
    kind === 'binary' ? size : [size, t('previewUnavailableHint')].filter(Boolean).join(' · ')

  return <EmptyState title={title} hint={hint} icon={icon} />
}
