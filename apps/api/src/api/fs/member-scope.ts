import { createHash } from "node:crypto";
import type { FsService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import { memberMemorySlug } from "@everdict/contracts";

// The filesystem as THIS caller sees it. The scope is the authenticated subject and nothing else: an agent calls
// the control plane with the member's own credential (see fs-actor.ts), so an agent working for a member reaches
// exactly that member's memory — which is the point, since it is the agent that learned it — and an agent working
// for nobody reaches none of it.
//
// Every member- and agent-facing filesystem surface goes through here. The bare `deps.fsService` stays the
// INTERNAL view for content projections and operator paths, so a route using it directly is the thing to notice
// in review.
export function memberFs(fs: FsService, principal: Principal): FsService {
  return fs.forMember(memberScopeOf(principal));
}

export function memberScopeOf(principal: Principal): string {
  return memberMemorySlug(principal.subject, (input) => createHash("sha256").update(input).digest("hex"));
}
