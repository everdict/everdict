// Turning a read response back into bytes, in the browser. The control plane hands text as utf-8 and everything
// else as base64 (`FsFileContent.encoding`); a Blob is what both an <object>/<video> source and a download need.

// Returns the ArrayBuffer rather than the view: a Blob part accepts either, and the buffer sidesteps the
// ArrayBufferLike/SharedArrayBuffer split that a bare Uint8Array carries in its type.
function base64Buffer(content: string): ArrayBuffer {
  const binary = atob(content.replace(/\s+/g, ''))
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return buffer
}

export function fileBlob(
  content: string,
  encoding: 'utf8' | 'base64',
  contentType: string | undefined
): Blob {
  const type = contentType ?? 'application/octet-stream'
  if (encoding === 'utf8') return new Blob([content], { type })
  return new Blob([base64Buffer(content)], { type })
}

// Hand the file to the browser's own download flow. An object URL (not a data: URI) keeps a 5 MiB payload out
// of the DOM and lets the browser stream it; it is revoked on the next tick, once the click has been consumed.
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
