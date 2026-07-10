import type { CommentRecord } from "@everdict/contracts";

export interface CommentStore {
  add(record: CommentRecord): Promise<void>;
  // Oldest→newest (createdAt ASC) — timeline order. Workspace + resource scoped.
  list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]>;
  get(tenant: string, id: string): Promise<CommentRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
