import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAX_UPLOAD_BYTES, uploadFilesInto } from './upload-files'

// The upload fan-out talks to our own BFF door — stub fetch and assert what crosses it.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function entryFor(path: string): { path: string; name: string; kind: 'file' } {
  return { path, name: path.split('/').pop() ?? path, kind: 'file' }
}

function postedPath(init: RequestInit | undefined): string {
  const body = init?.body
  if (!(body instanceof FormData)) throw new Error('expected a multipart body')
  return String(body.get('path'))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadFilesInto', () => {
  it('posts each file into the picked folder under its safe name', async () => {
    const paths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        paths.push(postedPath(init))
        return jsonResponse(200, entryFor(postedPath(init)))
      })
    )

    const res = await uploadFilesInto('reports', [
      new File(['hi'], 'My Report.md', { type: 'text/markdown' }),
    ])

    // The OS name is folded to the fs charset — an unsafe name must never reach the control plane as-is.
    expect(paths).toEqual(['reports/My-Report.md'])
    expect(res.uploaded.map((e) => e.path)).toEqual(['reports/My-Report.md'])
    expect(res.failed).toEqual([])
  })

  it('refuses an oversized file before any bytes leave the browser', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const res = await uploadFilesInto('', [
      new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.bin'),
    ])

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.failed).toEqual([{ name: 'big.bin', kind: 'tooLarge' }])
  })

  it('reports a name collision as exists and keeps uploading the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const path = postedPath(init)
        // The control plane refuses a baseRevision-0 write over an existing path with a revision-worded 409.
        if (path === 'a.txt') return jsonResponse(409, { error: "'a.txt' moved on to revision 3" })
        return jsonResponse(200, entryFor(path))
      })
    )

    const res = await uploadFilesInto('', [new File(['x'], 'a.txt'), new File(['y'], 'b.txt')])

    expect(res.failed).toEqual([{ name: 'a.txt', kind: 'exists' }])
    expect(res.uploaded.map((e) => e.path)).toEqual(['b.txt'])
  })

  it('surfaces the server message on any other failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(400, { error: 'invalid path' }))
    )

    const res = await uploadFilesInto('', [new File(['x'], 'a.txt')])

    expect(res.failed).toEqual([{ name: 'a.txt', kind: 'error', error: 'invalid path' }])
  })
})
