import { describe, expect, it } from 'vitest'

import en from '../../../messages/en.json'
import ko from '../../../messages/ko.json'

// Catalog-wide ICU syntax guard. next-intl parses every message with tags enabled and strict
// argument types, so a literal `{a, b}` (INVALID_ARGUMENT_TYPE) or a lone `<id>` (UNCLOSED_TAG)
// makes the WHOLE message fail at render time — the screen shows the raw key path instead of the
// text, and nothing but a browser console notices. This happened to registerJudge.codeHint and
// datasetsPage.tbImageTemplateHelp; literal braces/angle brackets must be ICU-quoted (`'<id>'`).
//
// The checker is a reduction, not a full parser: strip quoted literals, erase valid ICU constructs
// (plural/select first — their option bodies would otherwise be eaten as simple arguments), and
// flag whatever braces or unclosed tags survive. Catalogs currently nest no arguments inside
// plural bodies; if one ever does, teach the reducer rather than weakening the assertion.

// ICU quoting: '' is a literal apostrophe; a quote before { } < # opens a literal run to the next '.
function stripQuoted(message: string): string {
  let out = ''
  for (let i = 0; i < message.length; i++) {
    const ch = message[i]
    if (ch === "'") {
      if (message[i + 1] === "'") {
        out += "'"
        i++
        continue
      }
      const next = message[i + 1]
      if (next === '{' || next === '<' || next === '}' || next === '#') {
        const end = message.indexOf("'", i + 1)
        if (end === -1) break
        i = end
        continue
      }
    }
    out += ch
  }
  return out
}

const PLURAL =
  /\{\s*[A-Za-z0-9_]+\s*,\s*(?:plural|selectordinal|select)\s*,(?:\s*(?:=\d+|[A-Za-z0-9_]+)\s*\{[^{}]*\})+\s*\}/g
const FORMATTED = /\{\s*[A-Za-z0-9_]+\s*,\s*(?:number|date|time)(?:\s*,[^{}]*)?\}/g
const SIMPLE = /\{\s*[A-Za-z0-9_]+\s*\}/g

function reduceIcu(message: string): string {
  let current = stripQuoted(message)
  for (;;) {
    // plural/select must go first: their option bodies ({None}, {# runs}) look like simple args.
    const plural = current.replace(PLURAL, '')
    if (plural !== current) {
      current = plural
      continue
    }
    const rest = current.replace(FORMATTED, '').replace(SIMPLE, '')
    if (rest === current) return current
    current = rest
  }
}

function icuDefects(message: string): string[] {
  const reduced = reduceIcu(message)
  const defects: string[] = []
  if (reduced.includes('{') || reduced.includes('}')) defects.push('unquoted brace')
  for (const match of reduced.matchAll(/<([A-Za-z][A-Za-z0-9]*)\s*(\/?)>/g)) {
    if (match[2] === '/') continue
    if (!reduced.includes(`</${match[1]}>`)) defects.push(`unclosed tag <${match[1]}>`)
  }
  return defects
}

function collectDefects(catalog: unknown, path: string): string[] {
  if (typeof catalog === 'string') {
    return icuDefects(catalog).map((d) => `${path}: ${d}`)
  }
  if (catalog !== null && typeof catalog === 'object') {
    return Object.entries(catalog).flatMap(([key, value]) =>
      collectDefects(value, path ? `${path}.${key}` : key)
    )
  }
  return []
}

describe('message catalogs', () => {
  it.each([
    ['en', en],
    ['ko', ko],
  ])('%s messages contain no ICU syntax that fails at render time', (_locale, catalog) => {
    expect(collectDefects(catalog, '')).toEqual([])
  })
})
