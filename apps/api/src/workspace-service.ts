import { randomBytes } from "node:crypto";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@everdict/core";
import type { WorkspaceRecord, WorkspaceStore, WorkspaceWithRole } from "@everdict/db";
import { validateImageRef } from "./image-ref.js";

// Service core for self-serve workspace membership — shared by the HTTP route and the MCP tool (parity: one logic, two transports).
// Operates on the authenticated subject (no workspace-internal role gate — creating a new workspace is self-serve, open to anyone).
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Display name → URL-safe slug (workspace id = tenant key). Non-alphanumeric → hyphen, max 40 chars.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export class WorkspaceService {
  constructor(private readonly store: WorkspaceStore) {}

  // Workspaces I'm a member of (with role).
  async listForSubject(subject: string): Promise<WorkspaceWithRole[]> {
    return this.store.listForSubject(subject);
  }

  // The active workspace's record (id/name/owner/logoUrl/createdAt). 404 if absent.
  async get(workspace: string): Promise<WorkspaceRecord> {
    const rec = await this.store.get(workspace);
    if (!rec) throw new NotFoundError("NOT_FOUND", { workspace }, "Workspace not found.");
    return rec;
  }

  // Update display info (name/logo). The slug (id) is immutable. An empty-string logoUrl means removing the logo.
  async update(workspace: string, input: { name?: string; logoUrl?: string }): Promise<WorkspaceRecord> {
    const patch: { name?: string; logoUrl?: string | null } = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestError("BAD_REQUEST", { field: "name" }, "Workspace name is required.");
      if (name.length > 80)
        throw new BadRequestError("BAD_REQUEST", { field: "name" }, "Name must be at most 80 characters.");
      patch.name = name;
    }
    if (input.logoUrl !== undefined) {
      const clean = input.logoUrl.trim();
      patch.logoUrl = clean === "" ? null : validateImageRef(clean, "logoUrl"); // empty string → remove
    }
    const updated = await this.store.update(workspace, patch);
    if (!updated) throw new NotFoundError("NOT_FOUND", { workspace }, "Workspace not found.");
    return updated;
  }

  // Hard-delete the workspace + all scoped data. Owner (creator) only — an ownership gate, not the role matrix.
  async delete(workspace: string, subject: string): Promise<void> {
    const rec = await this.store.get(workspace);
    if (!rec) throw new NotFoundError("NOT_FOUND", { workspace }, "Workspace not found.");
    if (rec.owner !== subject)
      throw new ForbiddenError(
        "FORBIDDEN",
        { workspace, action: "workspace:delete" },
        "Only the creator (owner) can delete a workspace.",
      );
    await this.store.delete(workspace);
  }

  // Self-serve creation: name (required) + optional id (slug). The creator becomes the workspace's admin.
  // An explicit-id collision is 409. A slug collision derived from the name is made unique with a short suffix (avoid a dead end).
  async create(subject: string, input: { name: string; id?: string }): Promise<WorkspaceWithRole> {
    const name = input.name.trim();
    if (!name) throw new BadRequestError("BAD_REQUEST", undefined, "Workspace name is required.");

    const explicit = typeof input.id === "string" && input.id.length > 0;
    let id = explicit ? (input.id as string).trim() : slugify(name);
    if (!id || !SLUG.test(id))
      throw new BadRequestError("BAD_REQUEST", undefined, "Workspace ID must match ^[a-z0-9][a-z0-9-]*$.");

    let created = await this.store.create({ id, name, owner: subject });
    if (!created && explicit) throw new ConflictError("CONFLICT", { id }, `Workspace ID already exists: ${id}`);

    const stem = slugify(name) || "ws";
    for (let attempt = 0; !created && attempt < 6; attempt += 1) {
      id = `${stem}-${randomBytes(2).toString("hex")}`;
      created = await this.store.create({ id, name, owner: subject });
    }
    if (!created)
      throw new ConflictError(
        "CONFLICT",
        undefined,
        "Could not create a unique workspace ID. Try specifying an id yourself.",
      );

    return { id: created.id, name: created.name, role: "admin" };
  }
}
