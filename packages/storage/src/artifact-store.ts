import type { EnvSnapshot } from "@everdict/core";

// 아티팩트(스크린샷 등 바이너리) 저장 추상화. put 은 가져올 수 있는 ref(URL)를 돌려준다 — presigned GET URL 또는 영구 URL.
// 구현: S3ArtifactStore(MinIO/S3, presigned), InMemoryArtifactStore(dev/테스트). 컨트롤플레인이 결과 영속화 전에 오프로드.
export interface ArtifactStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<string>;
}

// os-use 스냅샷의 동봉 base64 스크린샷을 object storage 로 오프로드 → screenshotRef=URL 로 치환하고 screenshot 은 비운다
// (결과 레코드 슬림화). store 가 없거나 base64 가 없으면 그대로 둔다(폴백: base64 인라인 — dev/InMemory 스토어 경로).
export async function offloadSnapshot(
  snapshot: EnvSnapshot,
  store: ArtifactStore | undefined,
  key: string,
): Promise<EnvSnapshot> {
  if (!store || snapshot.kind !== "os-use" || !snapshot.screenshot) return snapshot;
  const bytes = Buffer.from(snapshot.screenshot, "base64");
  const ref = await store.put(key, bytes, "image/png");
  return { ...snapshot, screenshotRef: ref, screenshot: "" }; // base64 제거 → 레코드에 URL 만
}

// dev/테스트용 in-process 스토어. 바이트를 Map 에 보관, ref 는 memory:// URL. 영속/공유 안 됨(InMemory run-store 와 동일 포스처).
export class InMemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, { data: Uint8Array; contentType: string }>();
  constructor(private readonly baseUrl = "memory://artifacts/") {}
  async put(key: string, data: Uint8Array, contentType: string): Promise<string> {
    this.objects.set(key, { data, contentType });
    return `${this.baseUrl}${key}`;
  }
}
