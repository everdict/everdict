import type { CapabilityOrigin, IssueLinkType } from "@everdict/contracts";
import { SHARED_TENANT } from "@everdict/domain";
import type { NewIssueLinkInput } from "@everdict/domain";
import type { IssueActor } from "./issue-service.js";

// A capability that says it was born from an issue makes the issue say so too.
//
// The two directions used to be independent acts: the registration recorded nothing, and whoever built the judge
// had to remember a separate `add_issue_link` call. That is exactly the kind of bookkeeping that gets skipped —
// and skipping it is not cosmetic, because the regression watch only reopens a closed issue when the batch's
// dataset AND harness are both linked to it. An agent that built and ran the evaluation but forgot the link left
// the issue unable to notice its own regression.
//
// So the link is made where the birth is recorded: one act, both directions. Like the fact decorator beside it,
// this sits at the COMPOSITION ROOT rather than in each route/tool, so headless callers (bundle apply, the CI
// re-pin) cannot fork the behaviour.
//
// Best-effort by contract, in both failure directions:
//   - already linked → ConflictError, which is the state we wanted anyway. Swallowed.
//   - anything else (the issue was deleted, the store is down) → swallowed too. The member's registration already
//     succeeded; failing it afterwards over a backlink would be a worse answer than a missing chip.
// The link deliberately carries NO version: an issue means "this judge", not "this judge at 1.2.0" (see
// IssueLink.version), and the regression watch matches at id level for the same reason.

// The one method this needs from the issue use-cases — structural, so the decorator is testable without a store
// and the composition root can hand it the real IssueService.
export interface IssueBacklinkPort {
  link(tenant: string, id: string, input: NewIssueLinkInput, actor: IssueActor): Promise<unknown>;
}

interface RegisterableSpec {
  id: string;
  version: string;
}

export function withOriginBacklink<
  S extends RegisterableSpec,
  R extends {
    register(tenant: string, spec: S, createdBy?: string, teamId?: string, origin?: CapabilityOrigin): Promise<void>;
  },
>(registry: R, linkType: Extract<IssueLinkType, "harness" | "dataset" | "judge">, issues: IssueBacklinkPort): R {
  const register = async (
    tenant: string,
    spec: S,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> => {
    await registry.register(tenant, spec, createdBy, teamId, origin); // a refused registration links nothing
    if (tenant === SHARED_TENANT) return; // seeding a first-party catalogue is not workspace news
    if (origin?.from?.type !== "issue" || createdBy === undefined) return;
    const issueId = origin.from.id;
    try {
      await issues.link(
        tenant,
        issueId,
        { type: linkType, id: spec.id, note: `Created from this issue (${spec.id}@${spec.version})` },
        {
          subject: createdBy,
          // The agent that acted rides along so the resulting `issue.linked` fact is stamped
          // `causedBy: agent:<id>:<conversation>` — loop guard #1 keys on that prefix, and an agent must not
          // wake on the link its own registration produced.
          ...(origin.agentId !== undefined || origin.conversationId !== undefined
            ? {
                agent: {
                  ...(origin.agentId !== undefined ? { agentId: origin.agentId } : {}),
                  ...(origin.conversationId !== undefined ? { conversationId: origin.conversationId } : {}),
                },
              }
            : {}),
        },
      );
    } catch {
      // Intentionally silent — see the contract above. The origin stamp survives either way, so the capability
      // still says where it came from even when the issue could not be told.
    }
  };
  // A Proxy rather than object spread: registry impls are classes, and a spread would drop every prototype
  // method. Bound functions keep `this` on the real instance. (Same reasoning as withRegisteredFact.)
  return new Proxy(registry, {
    get(target, prop) {
      if (prop === "register") return register;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
