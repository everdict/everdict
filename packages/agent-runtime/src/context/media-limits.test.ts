import { describe, expect, it } from "vitest";
import { imageOversizeReason, oversizedImageMark } from "./media-limits.js";

const dataUrl = (mediaType: string, bytes: Uint8Array) =>
  `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;

// A PNG's IHDR is always the first chunk, so a header is all it takes to know the size.
function png(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR payload length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

// SOI, then a decoy APP0 segment the walker must step over, then SOF0 carrying the frame size.
function jpeg(width: number, height: number): Uint8Array {
  const app0 = 20;
  const bytes = new Uint8Array(2 + 2 + app0 + 2 + 9);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xe0], 2);
  view.setUint16(4, app0);
  const sof = 4 + app0;
  bytes.set([0xff, 0xc0], sof);
  view.setUint16(sof + 2, 11);
  bytes[sof + 4] = 8; // sample precision
  view.setUint16(sof + 5, height);
  view.setUint16(sof + 7, width);
  return bytes;
}

describe("imageOversizeReason", () => {
  it("passes an ordinary screenshot — the common case must cost nothing", () => {
    expect(imageOversizeReason(dataUrl("image/png", png(1280, 800)))).toBeUndefined();
    expect(imageOversizeReason(dataUrl("image/jpeg", jpeg(1024, 768)))).toBeUndefined();
  });

  it("names the size of an image past the byte limit, in the units the message will show", () => {
    // Given 7M base64 characters — 5.25 MB decoded, just over the provider's per-image ceiling
    const reason = imageOversizeReason(`data:image/png;base64,${"A".repeat(7 * 1024 * 1024)}`);
    // Then the reason is a measurement, not a category: the model can tell how much smaller to ask for
    expect(reason).toMatch(/5\.3 MB, over the 5\.0 MB limit for one image/);
  });

  it("catches a full-page screenshot that is small in bytes but too tall — the case a size check alone misses", () => {
    // Given a mostly-blank 1200×14000 capture (long pages compress to very little)
    const reason = imageOversizeReason(dataUrl("image/png", png(1200, 14_000)));
    expect(reason).toBe("it is 1200×14000 pixels, over the 8000 px limit on a side");
    // …and the same check reads a JPEG's SOF, stepping over the metadata segment in front of it
    expect(imageOversizeReason(dataUrl("image/jpeg", jpeg(9000, 600)))).toMatch(/9000×600/);
  });

  it("judges an unreadable header on SIZE alone — dropping a legal image is the expensive mistake", () => {
    // A format we cannot parse (WebP here) and a truncated PNG both pass when they are small enough
    expect(imageOversizeReason(dataUrl("image/webp", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])))).toBe(
      undefined,
    );
    expect(imageOversizeReason(dataUrl("image/png", png(1, 1).slice(0, 12)))).toBeUndefined();
    // A hosted URL is fetched by the provider, so there is nothing here to measure
    expect(imageOversizeReason("https://example.test/shot.png")).toBeUndefined();
  });

  it("tells the model what to do instead of retrying the same call", () => {
    expect(oversizedImageMark("it is 12.0 MB, over the 5.0 MB limit for one image")).toMatch(
      /smaller region or a lower resolution/,
    );
  });
});
