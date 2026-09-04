'use client'

import { useState } from 'react'

import { cn } from '@/shared/lib/utils'
import { Markdown } from '@/shared/ui/markdown'

// The skill document viewer (read-only) — the SKILL.md body plus attached files opened as tabs (a reinterpretation of the Claude Code skill
// directory: the body is the document, the files are on-demand reference material). A skill is no longer a single document but several files,
// so the store detail and the skill management detail share this ONE viewer and cannot diverge in presentation. A .md file renders as markdown
// (a ```mermaid fence becomes a diagram); anything else is raw mono.
export function SkillDocs({
  instructions,
  files,
  className,
}: {
  instructions: string
  files: { path: string; content: string }[]
  className?: string
}) {
  // '' = the SKILL.md body tab; anything else = the attached-file tab at that path.
  const [tab, setTab] = useState('')
  const activeFile = files.find((f) => f.path === tab)
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      {/* The document tabs — SKILL.md plus one per file. With no files the tab row itself hides (the empty-section convention). */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-0.5 border-b border-border bg-muted/30 px-2 pt-1.5">
          {['', ...files.map((f) => f.path)].map((p) => (
            <button
              key={p === '' ? 'SKILL.md' : p}
              type="button"
              onClick={() => setTab(p)}
              className={cn(
                'rounded-t-md border-b-2 px-2.5 py-1.5 font-mono text-[12px] transition-colors',
                tab === p
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {p === '' ? 'SKILL.md' : p}
            </button>
          ))}
        </div>
      )}
      <div className="p-4">
        {activeFile === undefined ? (
          <Markdown content={instructions} mermaid className="text-[13px]" />
        ) : activeFile.path.endsWith('.md') ? (
          <Markdown content={activeFile.content} mermaid className="text-[13px]" />
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted-foreground">
            {activeFile.content}
          </pre>
        )}
      </div>
    </div>
  )
}
