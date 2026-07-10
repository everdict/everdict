import type { ArtifactStore } from "@everdict/application-control";

// In-process store for dev/test. Keeps bytes in a Map, ref is a memory:// URL. Not persisted/shared (same posture as the InMemory run-store).
export class InMemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, { data: Uint8Array; contentType: string }>();
  constructor(private readonly baseUrl = "memory://artifacts/") {}
  async put(key: string, data: Uint8Array, contentType: string): Promise<string> {
    this.objects.set(key, { data, contentType });
    return `${this.baseUrl}${key}`;
  }
}
