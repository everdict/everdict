import { BadRequestError } from "@everdict/contracts";

// Display-image reference validation — allows both an externally hosted http(s) URL and a data:image
// base64 uploaded after resizing on the web. (Self-contained, no storage infra — a small image resized
// to 256px sits directly in the profile/workspace TEXT column.) Shared by the profile avatar and the
// workspace logo; moved from apps/api common in re-architecture P2d (one rule, one home).
// field is the field name in error messages/data.
const MAX_DATA_URL = 1_400_000; // room for a ~1MB image (base64 +33%). The web resizes to a 256px JPEG before sending.
const DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function validateImageRef(v: string | null, field: string): string | null {
  if (v === null) return null;
  if (v.startsWith("data:")) {
    if (v.length > MAX_DATA_URL) throw new BadRequestError("BAD_REQUEST", { field }, "Image is too large.");
    if (!DATA_URL_RE.test(v)) throw new BadRequestError("BAD_REQUEST", { field }, "Unsupported image format.");
    return v;
  }
  if (v.length > 2048) throw new BadRequestError("BAD_REQUEST", { field }, "URL is too long.");
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new BadRequestError("BAD_REQUEST", { field }, "Not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new BadRequestError("BAD_REQUEST", { field }, "Only an http(s) URL or an uploaded image is allowed.");
  return v;
}
