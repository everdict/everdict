import type { RetrievalReceipt, RetrievalReceiptOutcome, RetrievalUse } from "@everdict/contracts";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

// The receipt's home is the workspace filesystem, for the reason view captures live there
// (docs/architecture/workspace-filesystem.md §View captures): it is an accumulating series that needs
// attribution and a browsable home, and it is not a lifecycle transition, so it is not a platform event
// (`.claude/rules/events.md` — facts from transitions; the same stream is the pulse's activity feed).
//
//   knowledge/retrievals/<YYYY-MM-DD>/<sessionId>/assembly-<n>.json   ← written HERE, by the assembly
//   knowledge/retrievals/<YYYY-MM-DD>/<sessionId>/used.json           ← written by the SESSION, separately
//
// One directory per session, and the two authors never share a path. A session's account of what it used is
// worth having and is not evidence of what was returned; storing them in one file would make the weaker
// claim unreadable from the stronger one.
export interface RetrievalReceiptWriter {
  write(receipt: RetrievalReceipt): Promise<RetrievalReceiptOutcome>;
  // The session's account, beside the assembly's files and never inside one: two authors, two paths, so a
  // transcription can never be read as a stamp.
  writeUse(use: RetrievalUse): Promise<RetrievalReceiptOutcome>;
}

// Path segments accept only [A-Za-z0-9._-]; a session id is a generated uuid today, but sanitising here means
// a future correlator cannot write outside the tree by carrying a slash.
const segment = (raw: string): string => raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);

export function fsRetrievalReceiptWriter(fs: WorkspaceFs): RetrievalReceiptWriter {
  return {
    async write(receipt) {
      const day = receipt.at.slice(0, 10);
      const dir = `knowledge/retrievals/${day}/${segment(receipt.sessionId)}`;
      const body = new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`);
      // A NEW FILE PER ASSEMBLY, never an overwrite: the second call of a session is a second observation,
      // and a path that converges on one file would record only the last one — the same thing a mutable
      // "current" does to a ledger. The clock supplies the ordering, and the colons come out because path
      // segments refuse them.
      const stamp = receipt.at.replace(/[:.]/g, "-");
      const path = `${dir}/assembly-${stamp}.json`;
      try {
        await fs.write(receipt.tenant, path, body, "application/json");
        return { recorded: true, path };
      } catch (err) {
        // Reported, never thrown: the context is the product and a read must not fail because its receipt
        // could not be filed. Reported, never swallowed: a measurement series with invisible holes reads
        // exactly like coverage.
        return { recorded: false, reason: "write_failed", detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async writeUse(use) {
      const dir = use.assemblyPath.split("/").slice(0, -1).join("/");
      if (dir === "" || !dir.startsWith("knowledge/retrievals/"))
        return {
          recorded: false,
          reason: "write_failed",
          detail: `'${use.assemblyPath}' is not an assembly receipt path — the session's account belongs beside the assembly it accounts for`,
        };
      const path = `${dir}/used.json`;
      try {
        await fs.write(
          use.tenant,
          path,
          new TextEncoder().encode(`${JSON.stringify(use, null, 2)}\n`),
          "application/json",
        );
        return { recorded: true, path };
      } catch (err) {
        return { recorded: false, reason: "write_failed", detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
