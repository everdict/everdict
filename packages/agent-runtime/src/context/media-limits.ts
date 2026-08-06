// What ONE image may be on the wire. A provider rejects an oversized image with an error that names neither the
// tool that produced it nor the image itself, so the turn dies on something the model cannot see and cannot fix —
// the same opaque-400 class as the per-request media count (see capMedia). Anthropic's ceilings: 5 MB of image
// data, and 8000 px on a side.
//
// A full-page browser screenshot reaches both on an ordinary long page, so this is the everyday case, not the
// exotic one. We do not resize (that would mean an image codec in the agent kernel); we replace the image with a
// line saying exactly what was wrong with it, which is what lets the model ask the tool for a smaller region or a
// lower resolution instead of retrying the same failing call.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 8_000;
// Enough of the file to hold a PNG header and, for JPEG, the SOF marker behind whatever metadata precedes it.
const HEADER_SCAN_BYTES = 65_536;

function base64Payload(url: string): string | undefined {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return undefined;
  return url.slice(comma + 1);
}

// Byte length of a base64 payload without decoding it: 3 bytes per 4 characters, less the padding.
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function headerBytes(base64: string): Uint8Array {
  const chars = Math.min(base64.length, Math.ceil((HEADER_SCAN_BYTES * 4) / 3));
  return new Uint8Array(Buffer.from(base64.slice(0, chars - (chars % 4)), "base64"));
}

// Dimensions read from the file header — PNG exactly (IHDR is always the first chunk), JPEG by walking segment
// markers to the first SOF. Anything else (WebP, GIF, a truncated header) returns undefined and is judged on size
// alone: a guess here would drop a legal image, and dropping is the expensive mistake.
function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isPng = bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (!(bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8)) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++; // fill byte or padding between segments
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === undefined) return undefined;
    // SOFn carries the frame's size; C4/C8/CC are Huffman/arithmetic tables that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone marker, no payload
      continue;
    }
    i += 2 + view.getUint16(i + 2);
  }
  return undefined;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Why this image cannot go on the wire, phrased for the model that will read it in place of the image — undefined
// when it is fine. Both checks are on the ORIGINAL image, so the message names the actual measurement.
export function imageOversizeReason(url: string): string | undefined {
  const base64 = base64Payload(url);
  if (base64 === undefined) return undefined; // a hosted URL — the provider fetches it, we cannot measure it
  const bytes = decodedByteLength(base64);
  if (bytes > MAX_IMAGE_BYTES) {
    return `it is ${megabytes(bytes)}, over the ${megabytes(MAX_IMAGE_BYTES)} limit for one image`;
  }
  const size = imageDimensions(headerBytes(base64));
  if (size && (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE)) {
    return `it is ${size.width}×${size.height} pixels, over the ${MAX_IMAGE_EDGE} px limit on a side`;
  }
  return undefined;
}

export function oversizedImageMark(reason: string): string {
  return `[image dropped before sending: ${reason}. Ask the tool for a smaller region or a lower resolution — resending the same call will fail the same way.]`;
}
