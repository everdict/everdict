'use client'

import { useState, useTransition } from 'react'
import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { searchFilesAction, type FileMatch } from '../api/search-files'

// Find a file in a workspace tree you do not already know. Two inputs rather than one, because the control
// plane searches two different things and collapsing them would make the box lie about what it does: `glob`
// matches PATHS, `pattern` greps CONTENT.
export function FileSearch({ onOpen }: { onOpen?: (path: string) => void }) {
  const t = useTranslations('files')
  const [glob, setGlob] = useState('')
  const [pattern, setPattern] = useState('')
  const [matches, setMatches] = useState<FileMatch[]>()
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, start] = useTransition()

  function search() {
    setError(undefined)
    // The control plane refuses a search with neither, and refusing it here too keeps a stray Enter from
    // asking the server to walk the whole tree.
    if (glob.trim() === '' && pattern.trim() === '') return
    start(async () => {
      const res = await searchFilesAction({
        ...(glob.trim() ? { glob: glob.trim() } : {}),
        ...(pattern.trim() ? { pattern: pattern.trim() } : {}),
      })
      if (!res.ok) {
        setError(res.error ?? t('searchError'))
        return
      }
      setMatches(res.matches ?? [])
      setTruncated(res.truncated === true)
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={glob}
          onChange={(e) => setGlob(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder={t('searchGlobPlaceholder')}
          className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-transparent px-2 text-[13px]"
        />
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder={t('searchPatternPlaceholder')}
          className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-transparent px-2 text-[13px]"
        />
        <Button variant="outline" size="sm" onClick={search} disabled={busy}>
          <Search className="size-4" /> {t('search')}
        </Button>
      </div>
      {error !== undefined && <p className="text-[12px] text-destructive">{error}</p>}
      {matches !== undefined && matches.length === 0 && (
        <p className="text-[12px] text-muted-foreground">{t('searchNoMatches')}</p>
      )}
      {matches !== undefined && matches.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {matches.map((m, i) => (
            <li key={`${m.path}:${m.line ?? i}`} className="px-2.5 py-1.5">
              <button type="button" className="text-left" onClick={() => onOpen?.(m.path)}>
                <span className="font-mono text-[12.5px]">{m.path}</span>
                {m.line !== undefined && <span className="ml-2 text-[11px] text-faint">:{m.line}</span>}
              </button>
              {m.excerpt !== undefined && (
                <pre className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{m.excerpt}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* A cap fired, so the count is a FLOOR. Reporting it as the answer is what the control plane's own
          description warns about. */}
      {truncated && <p className="text-[12px] text-warning">{t('searchTruncated')}</p>}
    </div>
  )
}
