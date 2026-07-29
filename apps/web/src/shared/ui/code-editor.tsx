'use client'

import { useEffect, useState, type ComponentProps } from 'react'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { StreamLanguage, type StreamParser } from '@codemirror/language'
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

// The languages the editor highlights. 'node'/'python' are the authored-code ids (judge/grader editors) and get
// CodeMirror's full parsers; the rest are the workspace filesystem's long tail, served by the legacy stream
// modes — one small module per language, so breadth costs a lazy chunk rather than a bigger bundle. 'plain' is
// the honest fallback: line numbers and no colouring beats colouring a file as the wrong language.
export type CodeLanguage =
  | 'node'
  | 'python'
  | 'plain'
  | 'c'
  | 'clojure'
  | 'cpp'
  | 'csharp'
  | 'css'
  | 'dart'
  | 'diff'
  | 'dockerfile'
  | 'erlang'
  | 'go'
  | 'groovy'
  | 'haskell'
  | 'html'
  | 'http'
  | 'java'
  | 'julia'
  | 'kotlin'
  | 'less'
  | 'lua'
  | 'nginx'
  | 'perl'
  | 'powershell'
  | 'properties'
  | 'protobuf'
  | 'r'
  | 'ruby'
  | 'rust'
  | 'scala'
  | 'scss'
  | 'shell'
  | 'sql'
  | 'swift'
  | 'toml'
  | 'xml'
  | 'yaml'

type StreamLanguageId = Exclude<CodeLanguage, 'node' | 'python' | 'plain'>

// Dynamic imports with literal specifiers — each mode ships as its own chunk, loaded only when a file of that
// language is opened. Keeping them out of the initial bundle is what makes covering ~35 languages cheap.
const STREAM_MODES: Record<StreamLanguageId, () => Promise<StreamParser<unknown>>> = {
  c: async () => (await import('@codemirror/legacy-modes/mode/clike')).c,
  clojure: async () => (await import('@codemirror/legacy-modes/mode/clojure')).clojure,
  cpp: async () => (await import('@codemirror/legacy-modes/mode/clike')).cpp,
  csharp: async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp,
  css: async () => (await import('@codemirror/legacy-modes/mode/css')).css,
  dart: async () => (await import('@codemirror/legacy-modes/mode/clike')).dart,
  diff: async () => (await import('@codemirror/legacy-modes/mode/diff')).diff,
  dockerfile: async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile,
  erlang: async () => (await import('@codemirror/legacy-modes/mode/erlang')).erlang,
  go: async () => (await import('@codemirror/legacy-modes/mode/go')).go,
  groovy: async () => (await import('@codemirror/legacy-modes/mode/groovy')).groovy,
  haskell: async () => (await import('@codemirror/legacy-modes/mode/haskell')).haskell,
  html: async () => (await import('@codemirror/legacy-modes/mode/xml')).html,
  http: async () => (await import('@codemirror/legacy-modes/mode/http')).http,
  java: async () => (await import('@codemirror/legacy-modes/mode/clike')).java,
  julia: async () => (await import('@codemirror/legacy-modes/mode/julia')).julia,
  kotlin: async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin,
  less: async () => (await import('@codemirror/legacy-modes/mode/css')).less,
  lua: async () => (await import('@codemirror/legacy-modes/mode/lua')).lua,
  nginx: async () => (await import('@codemirror/legacy-modes/mode/nginx')).nginx,
  perl: async () => (await import('@codemirror/legacy-modes/mode/perl')).perl,
  powershell: async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell,
  properties: async () => (await import('@codemirror/legacy-modes/mode/properties')).properties,
  protobuf: async () => (await import('@codemirror/legacy-modes/mode/protobuf')).protobuf,
  r: async () => (await import('@codemirror/legacy-modes/mode/r')).r,
  ruby: async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby,
  rust: async () => (await import('@codemirror/legacy-modes/mode/rust')).rust,
  scala: async () => (await import('@codemirror/legacy-modes/mode/clike')).scala,
  scss: async () => (await import('@codemirror/legacy-modes/mode/css')).sCSS,
  shell: async () => (await import('@codemirror/legacy-modes/mode/shell')).shell,
  sql: async () => (await import('@codemirror/legacy-modes/mode/sql')).standardSQL,
  swift: async () => (await import('@codemirror/legacy-modes/mode/swift')).swift,
  toml: async () => (await import('@codemirror/legacy-modes/mode/toml')).toml,
  xml: async () => (await import('@codemirror/legacy-modes/mode/xml')).xml,
  yaml: async () => (await import('@codemirror/legacy-modes/mode/yaml')).yaml,
}

type EditorExtensions = NonNullable<ComponentProps<typeof CodeMirror>['extensions']>

// Resolves the language extension. The parsed languages are synchronous; a stream mode arrives a tick later, so
// the document renders unhighlighted first and gains colour when its chunk lands — never a spinner over content.
function useLanguageExtensions(language: CodeLanguage): EditorExtensions {
  const [extensions, setExtensions] = useState<EditorExtensions>([])
  useEffect(() => {
    if (language === 'plain') {
      setExtensions([])
      return
    }
    if (language === 'python') {
      setExtensions([python()])
      return
    }
    if (language === 'node') {
      setExtensions([javascript({ jsx: true, typescript: true })])
      return
    }
    let live = true
    void STREAM_MODES[language]()
      .then((parser) => {
        if (live) setExtensions([StreamLanguage.define(parser)])
      })
      .catch(() => {
        if (live) setExtensions([]) // a mode chunk that fails to load degrades to plain text, never to an error
      })
    return () => {
      live = false
    }
  }, [language])
  return extensions
}

// The code editor (CodeMirror 6) — real editing for user judge/grader code and for every text file in the
// workspace filesystem: line numbers, syntax highlight, auto-indent, bracket matching. Client-only by nature
// ('use client' + effects). Kept thin — a shared atom, not a feature. readOnly turns it into a highlighted
// viewer (judge detail, file viewer): same look, no cursor/edits, no focus ring.
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
  language: CodeLanguage
  minHeight?: string
  maxHeight?: string
  readOnly?: boolean
  className?: string
  'aria-label'?: string
}) {
  const theme = useThemeMode()
  const extensions = useLanguageExtensions(language)
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
        extensions={extensions}
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
