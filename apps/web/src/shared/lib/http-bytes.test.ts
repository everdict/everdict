import { describe, expect, it } from 'vitest'

import { bytesResponse, parseByteRange } from './http-bytes'

describe('parseByteRange', () => {
  it('is undefined without a Range header, so the whole file is served', () => {
    expect(parseByteRange(null, 100)).toBe(undefined)
    expect(parseByteRange('', 100)).toBe(undefined)
  })

  it('reads a closed range and clamps the end to the last byte', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseByteRange('bytes=90-999', 100)).toEqual({ start: 90, end: 99 })
  })

  it('reads an open range as "to the end"', () => {
    expect(parseByteRange('bytes=40-', 100)).toEqual({ start: 40, end: 99 })
  })

  it('reads a suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 })
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('refuses a range that starts past the end', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable')
  })

  // A multi-range request and an unrecognisable notation get the WHOLE response rather than a refusal — an answer the spec allows, so playback does not stop.
  it('serves the whole file for a multi-range or malformed header', () => {
    expect(parseByteRange('bytes=0-9,20-29', 100)).toBe(undefined)
    expect(parseByteRange('items=0-9', 100)).toBe(undefined)
  })
})

describe('bytesResponse', () => {
  const bytes = Buffer.from('0123456789')

  it('serves 200 with the full body and advertises range support', () => {
    const res = bytesResponse(bytes, { contentType: 'video/mp4' })

    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('10')
    expect(res.headers.get('cache-control')).toContain('private')
  })

  // Safari will not play a <video> at all without a 206 — this one line is the boundary of "the video does not appear".
  it('serves 206 with just the asked-for slice', async () => {
    const res = bytesResponse(bytes, { contentType: 'video/mp4', rangeHeader: 'bytes=2-4' })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await res.text()).toBe('234')
  })

  it('answers 416 with the real size when the range is past the end', () => {
    const res = bytesResponse(bytes, { contentType: 'video/mp4', rangeHeader: 'bytes=50-' })

    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
  })

  it('carries a display filename without turning the response into a download', () => {
    const res = bytesResponse(bytes, { contentType: 'image/png', fileName: '스크린샷.png' })

    expect(res.headers.get('content-disposition')).toBe(
      "inline; filename*=UTF-8''%EC%8A%A4%ED%81%AC%EB%A6%B0%EC%83%B7.png"
    )
  })
})
