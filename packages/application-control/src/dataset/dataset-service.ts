import { BadRequestError, ForbiddenError } from "@everdict/contracts";
import { type Principal, contentDigest, groundTruthDeclarations } from "@everdict/domain";
import type { ConstitutionApprovalStore } from "../ports/constitution-approval-store.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import { deleteVersionedResource, deleteVersionedResources } from "../versioned-resource/versioned-resource-delete.js";

// Dataset-version deletion — the shared creator-or-admin mechanics live in versioned-resource-delete.ts
// (review §23: five byte-identical copies of one policy); these wrappers keep the resource's PUBLIC
// vocabulary concrete for both transports (BFF↔MCP parity).

const KIND = { permission: "datasets:delete", noun: "dataset" } as const;

export function deleteDatasetVersion(
  registry: DatasetRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  return deleteVersionedResource(registry, KIND, principal, id, version);
}

export function deleteDatasetVersions(
  registry: DatasetRegistry,
  principal: Principal,
  id: string,
  versions?: readonly string[],
): Promise<{ workspace: string; id: string; deleted: string[] }> {
  return deleteVersionedResources(registry, KIND, principal, id, versions);
}

// ATTESTING A DECLARATION THAT PREDATES ITS GATE (arch-review 23 P1).
//
// A dataset whose graders declare `ground_truth` decides what passing means, and executing one now requires
// the receipt that says who authorized it. Datasets registered before that gate existed have no receipt, and
// there is no honest way to infer one: "it is in the database" is not evidence that anybody approved it.
//
// So an admin says so, explicitly, about ONE version's exact bytes — which is what makes the mode
// (`legacy_attested`) worth distinguishing from `approved`. The first was authorized before it could run; the
// second was authorized after it already had, and a reader auditing the constitution should be able to tell
// those apart forever.
//
// Refusing the no-op case matters as much: attesting a dataset that declares nothing constitutional would
// mint a receipt for an act nobody performed, and a receipt that can mean nothing is one that proves nothing.
export async function attestDatasetConstitution(
  deps: { datasets: DatasetRegistry; approvals: ConstitutionApprovalStore },
  principal: Principal,
  id: string,
  version: string,
  now: () => string = () => new Date().toISOString(),
): Promise<{ workspace: string; id: string; version: string; metrics: string[]; mode: "legacy_attested" }> {
  if (!principal.roles.includes("admin"))
    throw new ForbiddenError(
      "FORBIDDEN",
      { id, version },
      "Attesting a dataset's ground_truth declarations requires the admin role — it authorizes what passing means for every evaluation that runs it.",
    );
  const dataset = await deps.datasets.get(principal.workspace, id, version);
  const metrics = groundTruthDeclarations(dataset.cases);
  if (metrics.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { id, version },
      `The dataset '${id}@${version}' declares no ground_truth authority, so there is nothing to attest — an approval for an act nobody performed proves nothing.`,
    );
  await deps.approvals.record(principal.workspace, {
    kind: "dataset",
    id: dataset.id,
    version: dataset.version,
    // THESE bytes. A version is immutable, so this pins the attestation to what was actually read.
    contentDigest: contentDigest(dataset),
    metrics,
    mode: "legacy_attested",
    approvedBy: principal.subject,
    approvedAt: now(),
  });
  return { workspace: principal.workspace, id: dataset.id, version: dataset.version, metrics, mode: "legacy_attested" };
}
