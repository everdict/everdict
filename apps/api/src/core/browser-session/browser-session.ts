import type { ProvisionedBrowser } from "../../common/browser-session-provisioner.js";

// An interactive remote browser session (browser-profiles S1): a dedicated browser the owner drives live over a WS
// to log into a site. Personal / self-scoped (owner = the subject that created it, like connected accounts) — never
// a workspace-shared resource. Transient: sessions live in memory only (no persistence) and are swept on TTL.
export type BrowserSessionStatus = "active" | "closed";

export interface BrowserSessionRecord {
  id: string;
  tenant: string; // the creator's workspace — display/scope metadata only (ownership is by subject)
  createdBy: string; // subject — the owner
  status: BrowserSessionStatus;
  // The reachable CDP base of the dedicated browser. SERVER-ONLY: never leaves the control plane (the raw CDP
  // endpoint is a full remote-control channel). The WS relay reads it internally; the client only gets a ticket.
  cdpBase: string;
  createdAt: string;
  expiresAt: number; // epoch ms — TTL sweep tears the browser down after this.
}

// The live in-memory entry: the record plus the disposer for the provisioned browser.
export interface BrowserSessionEntry {
  record: BrowserSessionRecord;
  browser: ProvisionedBrowser;
}

// The client-facing view — deliberately OMITS cdpBase (server-only).
export interface BrowserSessionView {
  id: string;
  status: BrowserSessionStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: number;
}

export function toBrowserSessionView(record: BrowserSessionRecord): BrowserSessionView {
  return {
    id: record.id,
    status: record.status,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}
