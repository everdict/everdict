// THE RECEIPT FOR A CONSTITUTIONAL DECLARATION (mig 0165).
//
// A dataset whose graders declare `ground_truth` redefines what passing means for every evaluation that ever
// runs it, so registering one requires the admin role. Authorization at the door leaves no trace, though —
// and a dataset already in the database is indistinguishable between "an admin approved it", "a member
// registered it before the gate existed" and "it is a platform seed". Those are three different facts and a
// trust kernel may not read them as one.
//
// The receipt is stored BESIDE the artifact, never inside it: provenance inside a versioned spec would
// change the content digest of the very thing being approved.
export type ConstitutionApprovalMode = "approved" | "platform_seed" | "legacy_attested";

export interface ConstitutionApproval {
  kind: "dataset";
  id: string;
  version: string;
  // WHICH bytes were approved. A re-registration with different content is a different constitutional act,
  // and an approval that named only `id@version` would silently cover it.
  contentDigest: string;
  metrics: string[];
  mode: ConstitutionApprovalMode;
  approvedBy?: string;
  approvedAt: string;
}

export interface ConstitutionApprovalStore {
  record(tenant: string, approval: ConstitutionApproval): Promise<void>;
  // Undefined = no receipt: this artifact's declarations were never authorized under this regime. That is a
  // state to surface, not a default to pass.
  find(tenant: string, kind: "dataset", id: string, version: string): Promise<ConstitutionApproval | undefined>;
}

// PUBLISHING A CONSTITUTIONAL DATASET IS ONE ACT (arch-review 25 P0-2).
//
// The receipt and the dataset are two writes owned by two different adapters — the approval store and the
// versioned registry — so no single statement can span them, and ordering them (receipt first) only moved the
// window rather than closing it. What sits inside that window is a state the trust kernel has no vocabulary
// for: bytes registered under a name whose recorded approval names DIFFERENT bytes, or a receipt authorising
// a document that does not exist. The second is harmless; the first is a dataset that decides what passing
// means while the artifact an admin signed is not the artifact that runs.
//
// So the boundary that owns both adapters — the composition root, the only layer that can see one connection
// underneath two stores — publishes them together or not at all. A deployment that cannot transact cannot
// publish a constitutional dataset: refusing is recoverable, and a half-published constitution is not.
export interface ConstitutionalPublisher {
  publish(input: {
    tenant: string;
    dataset: { id: string; version: string } & Record<string, unknown>;
    approval: ConstitutionApproval;
    createdBy?: string;
    origin?: unknown;
  }): Promise<void>;
}
