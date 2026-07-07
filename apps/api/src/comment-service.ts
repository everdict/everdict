import { BadRequestError, ForbiddenError, NotFoundError } from "@everdict/core";
import type { CommentRecord, CommentStore } from "@everdict/db";

// Comment service — collaborative discussion on resources (harness/dataset/scorecard/view/schedule/job/runtime) + single-level replies.
// Shared by HTTP routes and MCP tools (BFF↔MCP parity). authZ: read=comments:read, write=comments:write, delete=author-or-admin.
export const COMMENT_RESOURCE_TYPES = [
  "dataset",
  "harness",
  "scorecard",
  "view",
  "schedule",
  "run",
  "runtime",
] as const;
export type CommentResourceType = (typeof COMMENT_RESOURCE_TYPES)[number];

const MAX_BODY = 10_000; // cap the body (plenty for rich discussion, blocks DoS)

export interface CommentServiceDeps {
  store: CommentStore;
  // Mention notification hook — called when a comment contains an @-mention (recipients excluding the author). Silently skipped if unset.
  // Wired in main.ts to NotificationService.notifyMention (including actor-name resolution).
  notifyMention?: (input: { tenant: string; comment: CommentRecord; recipients: string[] }) => Promise<void>;
  newId?: () => string;
  now?: () => string;
}

export class CommentService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: CommentServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private assertType(resourceType: string): void {
    if (!(COMMENT_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
      throw new BadRequestError("BAD_REQUEST", { resourceType }, `Unsupported comment target: ${resourceType}`);
    }
  }

  // A resource's comments (oldest→newest, timeline order). Workspace-scoped.
  list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]> {
    this.assertType(resourceType);
    return this.deps.store.list(tenant, resourceType, resourceId);
  }

  // Post a comment. Empty/overlong body → 400. author = author subject. mentions = @-mentioned subjects (notified, excluding the author).
  // With parentId it's a reply — only allowed on a "top-level" comment of the same resource (single-level thread; 400 if the parent is already a reply).
  async create(input: {
    tenant: string;
    resourceType: string;
    resourceId: string;
    author: string;
    body: string;
    parentId?: string;
    mentions?: string[];
  }): Promise<CommentRecord> {
    this.assertType(input.resourceType);
    const body = input.body.trim();
    if (body.length === 0) throw new BadRequestError("BAD_REQUEST", undefined, "Comment content is required.");
    if (body.length > MAX_BODY)
      throw new BadRequestError("BAD_REQUEST", { max: MAX_BODY }, `Comment must be at most ${MAX_BODY} characters.`);
    if (input.parentId) {
      const parent = await this.deps.store.get(input.tenant, input.parentId);
      if (!parent || parent.resourceType !== input.resourceType || parent.resourceId !== input.resourceId)
        throw new BadRequestError("BAD_REQUEST", { parentId: input.parentId }, "Parent comment not found.");
      if (parent.parentId)
        throw new BadRequestError("BAD_REQUEST", { parentId: input.parentId }, "Cannot reply to a reply.");
    }
    const ts = this.now();
    const record: CommentRecord = {
      id: this.newId(),
      tenant: input.tenant,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      author: input.author,
      body,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.add(record);
    // Mention notifications — exclude the author, dedupe. A notification failure doesn't affect the comment result (swallowed).
    const recipients = [...new Set(input.mentions ?? [])].filter((s) => s && s !== input.author);
    if (recipients.length > 0 && this.deps.notifyMention) {
      try {
        await this.deps.notifyMention({ tenant: input.tenant, comment: record, recipients });
      } catch {
        // Ignore notification failure (the comment is already saved).
      }
    }
    return record;
  }

  // Delete — the author or a workspace admin only. Missing → 404, unauthorized → 403.
  async delete(input: { tenant: string; id: string; subject: string; isAdmin: boolean }): Promise<void> {
    const existing = await this.deps.store.get(input.tenant, input.id);
    if (!existing) throw new NotFoundError("NOT_FOUND", { id: input.id }, "Comment not found.");
    if (existing.author !== input.subject && !input.isAdmin) {
      throw new ForbiddenError("FORBIDDEN", { id: input.id }, "Only the author or an admin can delete a comment.");
    }
    await this.deps.store.remove(input.tenant, input.id);
  }
}
