'use client'

import { useEffect, useState } from 'react'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import CodeMirror from '@uiw/react-codemirror'

import { cn } from '@/shared/lib/utils'

// Tracks the app theme (html.dark toggled by shared/ui/theme-toggle — no next-themes) so the editor follows it.
function useThemeMode(): 'light' | 'dark' {
  const [mode, setMode] = useState<'light' | 'dark'>('dark')
  useEffect(() => {
    const root = document.documentElement
    const read = () => setMode(root.classList.contains('dark') ? 'dark' : 'light')
    read()
    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return mode
}

// The code editor (CodeMirror 6) — real editing for user judge/grader code: line numbers, syntax highlight,
// auto-indent, bracket matching. Client-only by nature ('use client' + effects); language follows the judge's
// language toggle. Kept thin — a shared atom, not a feature. readOnly turns it into a highlighted viewer
// (judge detail): same look, no cursor/edits, no focus ring.
export function CodeEditor({
  value,
  onChange,
  language,
  minHeight = '320px',
  maxHeight,
  readOnly = false,
  className,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange?: (next: string) => void
  language: 'python' | 'node'
  minHeight?: string
  maxHeight?: string
  readOnly?: boolean
  className?: string
  'aria-label'?: string
}) {
  const theme = useThemeMode()
  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        'overflow-hidden rounded-md border border-border bg-card text-[12.5px] shadow-raise',
        !readOnly && 'focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/25',
        className
      )}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={theme}
        minHeight={minHeight}
        maxHeight={maxHeight}
        editable={!readOnly}
        readOnly={readOnly}
        extensions={[language === 'python' ? python() : javascript()]}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: !readOnly, // a viewer has no caret — an active-line bar would be noise
          autocompletion: false, // no token soup over user identifiers — plain, predictable editing
        }}
      />
    </div>
  )
}
