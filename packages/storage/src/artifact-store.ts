import { type ArtifactStore, artifactKeyOf } from "@everdict/application-control";

// In-process store for dev/test. Keeps bytes in a Map, ref is a memory:// URL. Not persisted/shared (same posture as the InMemory run-store).
export class InMemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, { data: Uint8Array; contentType: string }>();
  constructor(private readonly baseUrl = "memory://artifacts/") {}
  async put(key: string, data: Uint8Array, contentType: string): Promise<string> {
    this.objects.set(key, { data, contentType });
    return `${this.baseUrl}${key}`;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key)?.data;
  }

  // See the S3 twin for why this is on the class and not on the shared port. Two owners ask for it now: the
  // staged agent half, and trajectory RETENTION (arch-review 120).
  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  // memory:// refs don't expire and there is no second address to mint — a ref of ours is already the only
  // one; the stable artifact:// handle mints against the base like the S3 twin signs against its endpoint.
  async publicUrlFor(ref: string): Promise<string | undefined> {
    const key = artifactKeyOf(ref);
    if (key !== undefined) return this.objects.has(key) ? `${this.baseUrl}${key}` : undefined;
    return ref.startsWith(this.baseUrl) ? ref : undefined;
  }
}
