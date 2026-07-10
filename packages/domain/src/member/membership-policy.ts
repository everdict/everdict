import { ConflictError } from "@everdict/contracts";
import type { MemberRecord } from "@everdict/contracts";
import type { EverdictRole } from "../auth/authz.js";

// The last-admin invariant has ONE owner: a workspace must always keep at least one admin, so the mutation
// that would strip the final one (demotion / removal / self-leave) is forbidden (409). The three guards share
// the same core predicate but are intent-named — each mutation carries its own message (tests pin them), and
// only demotion depends on the new role (re-affirming admin is not a demotion).
// Plain class over a passed-in member list: the service already fetched it (target lookup / idempotent no-op),
// so injecting the store here would only duplicate the read. docs/architecture/rich-domain-core.md
export class MembershipPolicy {
  // Role change: demoting the last admin is forbidden. A "change" to admin is not a demotion and always passes.
  assertNotLastAdminDemotion(
    workspace: string,
    members: MemberRecord[],
    target: MemberRecord,
    newRole: EverdictRole,
  ): void {
    if (newRole === "admin") return;
    if (this.isLastAdmin(members, target))
      throw new ConflictError("CONFLICT", { workspace }, "The last admin cannot be demoted.");
  }

  // Removal (by another admin): removing the last admin is forbidden.
  assertNotLastAdminRemoval(workspace: string, members: MemberRecord[], target: MemberRecord): void {
    if (this.isLastAdmin(members, target))
      throw new ConflictError("CONFLICT", { workspace }, "The last admin cannot be removed.");
  }

  // Self-serve leave: the last admin cannot leave — the message tells them the way out (delegate or delete).
  assertCanLeave(workspace: string, members: MemberRecord[], me: MemberRecord): void {
    if (this.isLastAdmin(members, me))
      throw new ConflictError(
        "CONFLICT",
        { workspace },
        "The last admin cannot leave. Delegate admin to another member or delete the workspace.",
      );
  }

  // The shared invariant core: the subject is an admin and the only one left in the list.
  private isLastAdmin(members: MemberRecord[], subject: MemberRecord): boolean {
    return subject.role === "admin" && members.filter((m) => m.role === "admin").length === 1;
  }
}
