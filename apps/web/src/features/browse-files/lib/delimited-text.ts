// A small CSV/TSV reader for the viewer's table preview. Quoted fields (with escaped `""` and embedded
// separators/newlines) are honoured because spreadsheet exports produce them constantly; everything else is a
// split. This is a READER for display, not a parser to build on — a real data surface would page server-side.

export interface DelimitedTable {
  rows: string[][]
  truncated: boolean // more rows exist than were parsed
}

const MAX_ROWS = 200

export function parseDelimited(text: string, separator: ',' | '\t'): DelimitedTable {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (index < text.length && rows.length < MAX_ROWS) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (char === separator) {
      endField()
      index += 1
      continue
    }
    if (char === '\n') {
      endRow()
      index += 1
      continue
    }
    if (char === '\r') {
      index += 1
      continue
    }
    field += char
    index += 1
  }
  if (rows.length < MAX_ROWS && (field !== '' || row.length > 0)) endRow()

  return { rows, truncated: index < text.length }
}

export function separatorFor(path: string): ',' | '\t' {
  return path.toLowerCase().endsWith('.tsv') ? '\t' : ','
}
