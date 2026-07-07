import { BadRequestError } from "@everdict/core";
import type { UserProfile, UserProfilePatch, UserProfileStore } from "@everdict/db";
import { validateImageRef } from "./image-ref.js";

// Profile-edit core — the single core shared by the HTTP route (PATCH /me/profile) and the MCP tool (update_profile) (parity).
// Only edits your own profile (subject = principal.subject) — no role gate (authz-irrelevant display info decoupled from SSO identity).
// Does not handle email — it is a Keycloak claim, so read-only. An empty string is interpreted as deleting that field.
export class ProfileService {
  constructor(private readonly store: UserProfileStore) {}

  get(subject: string): Promise<UserProfile | undefined> {
    return this.store.get(subject);
  }

  async update(subject: string, input: { name?: string; username?: string; avatarUrl?: string }): Promise<UserProfile> {
    const patch: UserProfilePatch = {};
    if (input.name !== undefined) patch.name = validateName(clean(input.name));
    if (input.username !== undefined) patch.username = validateUsername(clean(input.username));
    if (input.avatarUrl !== undefined) patch.avatarUrl = validateImageRef(clean(input.avatarUrl), "avatarUrl");
    return this.store.upsert(subject, patch);
  }
}

// Empty/whitespace → null (delete), otherwise the trimmed value.
function clean(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

function validateName(v: string | null): string | null {
  if (v === null) return null;
  if (v.length > 80) throw new BadRequestError("BAD_REQUEST", { field: "name" }, "Name must be at most 80 characters.");
  return v;
}

// Username: alphanumeric + _/- (2–39 chars). Uniqueness is not yet enforced (format only).
function validateUsername(v: string | null): string | null {
  if (v === null) return null;
  if (!/^[a-z0-9][a-z0-9_-]{1,38}$/i.test(v))
    throw new BadRequestError("BAD_REQUEST", { field: "username" }, "Username must be 2–39 chars of alphanumeric/_/-.");
  return v;
}
