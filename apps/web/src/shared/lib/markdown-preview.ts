// A markdown body as a one-line preview — a list row has no room for a rendered document, and truncating the SOURCE leaks syntax like
// `## heading`, `- item` and `[name](url)` straight through (which is exactly how the list looked right after goal descriptions became
// markdown). Rather than squeezing a renderer into one line, this produces text with **the syntax stripped off**.
//
// It is a preview, not a parser: it goes as far as removing opening syntax and collapsing whitespace, and reproduces neither tables nor nesting.
const RULES: [RegExp, string][] = [
  [/```[\s\S]*?```/g, ' '], // a code block goes whole — there is nothing to keep in a one-line preview
  [/`([^`]+)`/g, '$1'],
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'], // an image keeps only its alt text
  [/\[([^\]]+)\]\([^)]*\)/g, '$1'], // a link keeps only its label
  [/^\s{0,3}#{1,6}\s+/gm, ''], // heading markers
  [/^\s{0,3}>\s?/gm, ''], // block quotes
  [/^\s{0,3}([-*+]|\d+\.)\s+/gm, ''], // list markers
  [/^\s{0,3}([-*_]\s?){3,}\s*$/gm, ' '], // horizontal rules
  [/(\*\*|__)(.*?)\1/g, '$2'], // emphasis
  [/(\*|_)(.*?)\1/g, '$2'],
  [/~~(.*?)~~/g, '$1'],
]

export function markdownPreview(body: string): string {
  let text = body
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement)
  return text.replace(/\s+/g, ' ').trim()
}
