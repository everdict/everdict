// The ANSI escape parser — it splits the raw process output a container or shell emitted into pieces a browser can draw.
// A service (a database, an agent server, a web framework) that decides it is attached to a TTY sends colour codes verbatim, and
// putting that source into a <pre> makes the browser draw "a row of boxes", because ESC (U+001B) is a control character with no glyph.
// With an English log body the words still read and the gaps between them break into boxes, which is easily mistaken for a broken encoding.
//
// So it is filtered once, just before display: SGR (colour, bold, dim, italic, underline) survives as style — a service painting ERROR red
// IS a signal in a runtime debugging panel — while the rest (cursor movement, screen clears, OSC window titles) and the C0 control
// characters are discarded. Colour is emitted only as CSS variables (--ansi-*) so it resolves to a readable value in light and dark alike.

const ESC = '\u001b'
const BEL = '\u0007'

// The eight base colour names of SGR 30–37 / 40–47. The bright variants (90–97, 100–107) use the same names with a `bright-` prefix.
const BASIC_COLORS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const

export interface AnsiStyle {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

export interface AnsiSpan {
  text: string
  style: AnsiStyle
}

function colorVar(name: string): string {
  return `var(--ansi-${name})`
}

// xterm 256-colour index → CSS colour. 0–15 resolve to the base/bright palette (theme variables), 16–231 to the 6×6×6 cube, and
// 232–255 to the greyscale ramp. The cube and the ramp are ABSOLUTE colours, so they are not candidates for theme variables.
function xterm256(n: number): string | undefined {
  if (n >= 0 && n < 8) return colorVar(BASIC_COLORS[n])
  if (n < 16) return colorVar(`bright-${BASIC_COLORS[n - 8]}`)
  if (n < 232) {
    const i = n - 16
    const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${level(Math.floor(i / 36))} ${level(Math.floor(i / 6) % 6)} ${level(i % 6)})`
  }
  if (n < 256) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v} ${v} ${v})`
  }
  return undefined
}

// The 38/48 extended colours — `5;<n>` (256-colour) or `2;<r>;<g>;<b>` (true colour). It also returns how many parameters it consumed so
// the caller can advance its cursor by that much. Not consuming them makes the remaining numbers read as the next SGR codes.
function extendedColor(
  params: number[],
  at: number
): { color: string | undefined; consumed: number } {
  const mode = at + 1 < params.length ? params[at + 1] : undefined
  if (mode === 5) {
    if (at + 2 >= params.length) return { color: undefined, consumed: 3 }
    return { color: xterm256(params[at + 2]), consumed: 3 }
  }
  if (mode === 2) {
    if (at + 4 >= params.length) return { color: undefined, consumed: 5 }
    const [r, g, b] = [params[at + 2], params[at + 3], params[at + 4]]
    const inRange = [r, g, b].every((v) => v >= 0 && v <= 255)
    return { color: inRange ? `rgb(${r} ${g} ${b})` : undefined, consumed: 5 }
  }
  return { color: undefined, consumed: 1 } // an unknown extended form — only the code itself is dropped
}

// Apply SGR parameters to the current style. An unrecognised code (inverse, blink, …) is silently ignored — all that matters is that it
// does not leak into the TEXT, and there is no reason to imitate effects that contribute nothing to log readability.
function applySgr(base: AnsiStyle, params: number[]): AnsiStyle {
  if (params.length === 0) return {} // "ESC[m" means the same as "ESC[0m" (reset)
  const style: AnsiStyle = { ...base }
  let i = 0
  while (i < params.length) {
    const code = params[i]
    let step = 1
    if (code === 0) {
      delete style.fg
      delete style.bg
      delete style.bold
      delete style.dim
      delete style.italic
      delete style.underline
    } else if (code === 1) style.bold = true
    else if (code === 2) style.dim = true
    else if (code === 3) style.italic = true
    else if (code === 4) style.underline = true
    else if (code === 22) {
      delete style.bold
      delete style.dim
    } else if (code === 23) delete style.italic
    else if (code === 24) delete style.underline
    else if (code >= 30 && code <= 37) style.fg = colorVar(BASIC_COLORS[code - 30])
    else if (code >= 90 && code <= 97) style.fg = colorVar(`bright-${BASIC_COLORS[code - 90]}`)
    else if (code >= 40 && code <= 47) style.bg = colorVar(BASIC_COLORS[code - 40])
    else if (code >= 100 && code <= 107) style.bg = colorVar(`bright-${BASIC_COLORS[code - 100]}`)
    else if (code === 39) delete style.fg
    else if (code === 49) delete style.bg
    else if (code === 38 || code === 48) {
      const { color, consumed } = extendedColor(params, i)
      if (color === undefined) {
        if (code === 38) delete style.fg
        else delete style.bg
      } else if (code === 38) style.fg = color
      else style.bg = color
      step = consumed
    }
    i += step
  }
  return style
}

// "1;31" → [1, 31]. An empty parameter is 0 (reset) by the spec. A token that does not parse as a number, such as the colon form
// (38:5:196), is DROPPED — giving up the style beats misreading it into the wrong colour, and it never leaks into the text either way.
function parseParams(raw: string): number[] {
  if (raw === '') return []
  return raw
    .split(';')
    .map((part) => (part === '' ? 0 : Number(part)))
    .filter((n) => Number.isInteger(n) && n >= 0)
}

// The check that spots input with nothing to filter — with no control characters at all (newline and tab aside), there is no reason to run
// the per-character loop below. The live log panel re-sends a whole snapshot of hundreds of thousands of characters every few seconds,
// and most of it is ordinary text using no colour.
const NEEDS_PARSING = /[\u0000-\u0008\u000b-\u001f\u007f]/

// Raw output → an array of styled pieces. A piece is split only where the STYLE changes, so an uncoloured log ends as a single piece.
export function parseAnsi(input: string): AnsiSpan[] {
  if (input === '') return []
  if (!NEEDS_PARSING.test(input)) return [{ text: input, style: {} }]

  const spans: AnsiSpan[] = []
  let style: AnsiStyle = {}
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') {
      spans.push({ text: buffer, style })
      buffer = ''
    }
  }

  let i = 0
  while (i < input.length) {
    const ch = input[i]

    if (ch === ESC) {
      const next = i + 1 < input.length ? input[i + 1] : undefined
      if (next === '[') {
        // CSI: parameter bytes → intermediate bytes → the final byte (@~). Only a final byte of 'm' is SGR; the rest are discarded.
        let j = i + 2
        while (j < input.length && /[0-9;:?<=>]/.test(input[j])) j++
        while (j < input.length && /[ -/]/.test(input[j])) j++
        if (j >= input.length) break // a truncated sequence — the remaining tail has nothing to display
        if (input[j] === 'm') {
          flush()
          style = applySgr(style, parseParams(input.slice(i + 2, j)))
        }
        i = j + 1
        continue
      }
      if (next === ']') {
        // OSC (a window title, etc.): discarded whole, up to BEL or ST (ESC \).
        let j = i + 2
        while (j < input.length) {
          if (input[j] === BEL) break
          if (input[j] === ESC && j + 1 < input.length && input[j + 1] === '\\') break
          j++
        }
        i = j < input.length && input[j] === ESC ? j + 2 : j + 1
        continue
      }
      i += next === undefined ? 1 : 2 // any other two-byte escape
      continue
    }

    if (ch === '\n' || ch === '\t') {
      buffer += ch
      i++
      continue
    }
    // CR folds into a newline: CRLF becomes one LF, and the lone CR a progress bar writes becomes a new line. Discarded entirely, every
    // progress-bar update would be appended onto one endlessly long line.
    if (ch === '\r') {
      if (!(i + 1 < input.length && input[i + 1] === '\n')) buffer += '\n'
      i++
      continue
    }
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) {
      i++ // the remaining C0 control characters plus DEL — no glyph, so they draw as boxes and are dropped
      continue
    }
    buffer += ch
    i++
  }

  flush()
  return spans
}
