import { BadRequestError } from "@everdict/core";

// 이미지 ref 공통 검증 — 외부 호스팅 http(s) URL 또는 웹에서 리사이즈해 올린 data:image base64 둘 다 허용.
// (스토리지 인프라 없이 자기완결 — 256px 로 줄인 작은 이미지가 프로필/워크스페이스 TEXT 컬럼에 그대로 담긴다.)
// 프로필 아바타와 워크스페이스 로고가 공유한다(중복 제거). field 는 에러 메시지/데이터의 필드명.
const MAX_DATA_URL = 1_400_000; // ~1MB 이미지(base64 +33%) 여유. 웹은 256px JPEG 로 줄여 보낸다.
const DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function validateImageRef(v: string | null, field: string): string | null {
  if (v === null) return null;
  if (v.startsWith("data:")) {
    if (v.length > MAX_DATA_URL) throw new BadRequestError("BAD_REQUEST", { field }, "이미지가 너무 큽니다.");
    if (!DATA_URL_RE.test(v)) throw new BadRequestError("BAD_REQUEST", { field }, "지원하지 않는 이미지 형식입니다.");
    return v;
  }
  if (v.length > 2048) throw new BadRequestError("BAD_REQUEST", { field }, "URL 이 너무 깁니다.");
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new BadRequestError("BAD_REQUEST", { field }, "유효한 URL 이 아닙니다.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new BadRequestError("BAD_REQUEST", { field }, "http(s) URL 또는 업로드한 이미지만 허용됩니다.");
  return v;
}
