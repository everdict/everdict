// ANSI 이스케이프 파서 — 컨테이너·셸이 뱉은 raw 프로세스 출력을 브라우저가 그릴 수 있는 조각으로 나눈다.
// 서비스(DB·에이전트 서버·웹 프레임워크)는 자기가 TTY 에 붙었다고 판단하면 컬러 코드를 그대로 실어 보내는데,
// 그 원문을 <pre> 에 꽂으면 ESC(U+001B)가 글리프 없는 제어문자라 브라우저가 "가로줄 몇 개짜리 상자"로 그린다.
// 로그 본문이 영어면 단어는 읽히고 그 사이사이가 상자로 깨져 보이므로 인코딩 깨짐처럼 오인되기 쉽다.
//
// 그래서 표시 직전에 한 번 걸러 낸다: SGR(색·굵기·흐림·기울임·밑줄)은 스타일로 살리고 — 서비스가 ERROR 를
// 빨강으로 칠한 건 런타임 디버깅 패널에서 그대로 신호다 — 커서 이동·화면 지우기·OSC(창 제목) 같은 나머지
// 시퀀스와 C0 제어문자는 버린다. 색은 CSS 변수(--ansi-*)로만 내보내서 라이트/다크에서 각각 읽히는 값이 된다.

const ESC = '\u001b'
const BEL = '\u0007'

// SGR 30~37 / 40~47 의 기본 8색 이름. 밝은 변형(90~97, 100~107)은 `bright-` 접두사를 붙인 같은 이름을 쓴다.
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

// xterm 256색 인덱스 → CSS 색. 0~15 는 기본/밝은 팔레트(테마 변수)로, 16~231 은 6×6×6 큐브,
// 232~255 는 그레이스케일 램프로 푼다. 큐브·램프는 절대색이라 테마 변수로 옮길 대상이 아니다.
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

// 38/48 확장색 — `5;<n>`(256색) 또는 `2;<r>;<g>;<b>`(트루컬러). 소비한 파라미터 개수를 함께 돌려줘서
// 호출부가 커서를 그만큼 밀 수 있게 한다. 소비하지 않으면 남은 숫자가 다음 SGR 코드로 오해된다.
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
  return { color: undefined, consumed: 1 } // 알 수 없는 확장 형식 — 코드 자체만 버린다
}

// SGR 파라미터를 현재 스타일에 적용한다. 인식 못 하는 코드(반전·깜빡임 등)는 조용히 무시 —
// 텍스트로 새어 나가지만 않으면 되고, 로그 가독성에 기여하지 않는 효과까지 흉내 낼 이유는 없다.
function applySgr(base: AnsiStyle, params: number[]): AnsiStyle {
  if (params.length === 0) return {} // "ESC[m" 은 "ESC[0m"(리셋)과 같다
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

// "1;31" → [1, 31]. 빈 파라미터는 스펙상 0(리셋)이다. 콜론 형식(38:5:196)처럼 숫자로 안 떨어지는 토큰은
// 버린다 — 잘못 해석해 엉뚱한 색을 입히느니 스타일을 포기하는 쪽이 낫고, 어차피 텍스트로는 새지 않는다.
function parseParams(raw: string): number[] {
  if (raw === '') return []
  return raw
    .split(';')
    .map((part) => (part === '' ? 0 : Number(part)))
    .filter((n) => Number.isInteger(n) && n >= 0)
}

// 걸러 낼 것이 하나도 없는 입력을 가려내는 검사 — 제어문자(줄바꿈·탭 제외)가 아예 없으면 아래 문자 단위
// 루프를 돌 이유가 없다. 라이브 로그 패널은 몇 초마다 수십만 자짜리 전체 스냅샷을 통째로 다시 넘기는데,
// 그 대부분은 색을 쓰지 않는 평범한 텍스트다.
const NEEDS_PARSING = /[\u0000-\u0008\u000b-\u001f\u007f]/

// raw 출력 → 스타일 조각 배열. 스타일이 바뀌는 지점에서만 조각이 나뉘므로 색 없는 로그는 조각 하나로 끝난다.
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
        // CSI: 파라미터 바이트 → 중간 바이트 → 최종 바이트(@~). 최종이 'm' 인 것만 SGR 이고 나머지는 버린다.
        let j = i + 2
        while (j < input.length && /[0-9;:?<=>]/.test(input[j])) j++
        while (j < input.length && /[ -/]/.test(input[j])) j++
        if (j >= input.length) break // 잘린 시퀀스 — 남은 꼬리는 표시할 것이 없다
        if (input[j] === 'm') {
          flush()
          style = applySgr(style, parseParams(input.slice(i + 2, j)))
        }
        i = j + 1
        continue
      }
      if (next === ']') {
        // OSC(창 제목 등): BEL 또는 ST(ESC \) 까지 통째로 버린다.
        let j = i + 2
        while (j < input.length) {
          if (input[j] === BEL) break
          if (input[j] === ESC && j + 1 < input.length && input[j + 1] === '\\') break
          j++
        }
        i = j < input.length && input[j] === ESC ? j + 2 : j + 1
        continue
      }
      i += next === undefined ? 1 : 2 // 그 밖의 2바이트 이스케이프
      continue
    }

    if (ch === '\n' || ch === '\t') {
      buffer += ch
      i++
      continue
    }
    // CR 은 줄바꿈으로 접는다: CRLF 는 LF 하나로, 진행바가 쓰는 단독 CR 은 새 줄로. 통째로 버리면
    // 진행바 갱신이 전부 한 줄에 이어 붙어 끝없이 긴 줄이 된다.
    if (ch === '\r') {
      if (!(i + 1 < input.length && input[i + 1] === '\n')) buffer += '\n'
      i++
      continue
    }
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) {
      i++ // 나머지 C0 제어문자 + DEL — 글리프가 없어 상자로 그려지므로 버린다
      continue
    }
    buffer += ch
    i++
  }

  flush()
  return spans
}
