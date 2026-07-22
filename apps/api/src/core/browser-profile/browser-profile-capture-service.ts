import type { BrowserProfileStore } from "@everdict/application-control";
import { BadRequestError, type BrowserProfileRecord, NotFoundError } from "@everdict/contracts";
import type { SecretCipher } from "@everdict/db";
import { type StorageState, captureStorageState, storageStateDomains } from "@everdict/topology";
import type { BrowserSessionService } from "../browser-session/browser-session-service.js";

// Capture an active interactive session's login into a saved profile (browser-profiles S3). Orchestrates the pieces
// that live above the pure metadata service: resolve the session's reachable CDP base (S1), read its cookies (a
// storageState), encrypt the blob (AES-256-GCM via the secret cipher), and persist it on the profile. Everything is
// owner-gated — both the profile and the session must belong to the caller. The encrypted blob is server-only.
export interface BrowserProfileCaptureServiceDeps {
  store: BrowserProfileStore;
  sessions: BrowserSessionService;
  cipher: SecretCipher;
  capture?: (cdpBase: string) => Promise<StorageState>; // injectable (tests); default = real CDP capture
  now?: () => string;
}

// A cookie the caller chose to keep, addressed the way the state preview reports it (domain without the
// leading dot + name). One login can set a dozen unrelated cookies — the selection is the user's intent.
export interface CookieSelection {
  domain: string;
  name: string;
}

export interface CaptureCommand {
  tenant: string;
  profileId: string;
  sessionId: string;
  subject: string;
  cookies?: CookieSelection[]; // absent = keep everything the session holds
}

export class BrowserProfileCaptureService {
  private readonly capture: (cdpBase: string) => Promise<StorageState>;
  private readonly now: () => string;

  constructor(private readonly deps: BrowserProfileCaptureServiceDeps) {
    this.capture = deps.capture ?? ((cdpBase) => captureStorageState(cdpBase));
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async captureInto(cmd: CaptureCommand): Promise<BrowserProfileRecord> {
    // Owner-gate the profile (a cross-owner id 404s, no existence leak).
    const profile = await this.deps.store.get(cmd.tenant, cmd.profileId);
    if (!profile || profile.createdBy !== cmd.subject)
      throw new NotFoundError("NOT_FOUND", { id: cmd.profileId }, "browser profile not found.");

    // Owner-gate the session + resolve its reachable CDP base (undefined = not the caller's / not active).
    const cdpBase = this.deps.sessions.cdpBaseFor(cmd.sessionId, cmd.subject);
    if (!cdpBase)
      throw new BadRequestError(
        "BAD_REQUEST",
        { sessionId: cmd.sessionId },
        "browser session not found or no longer active.",
      );

    const captured = await this.capture(cdpBase);
    const state = cmd.cookies ? filterState(captured, cmd.cookies) : captured;
    // A selection that matches nothing would silently store an empty login — the cookies changed between the
    // preview and the capture (e.g. the site rotated them). Surface it instead of saving a dead profile.
    if (cmd.cookies && state.cookies.length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { sessionId: cmd.sessionId },
        "none of the selected cookies are present in the session anymore.",
      );
    const stateCipher = JSON.stringify(this.deps.cipher.encrypt(JSON.stringify(state)));
    const capturedAt = this.now();
    const updated = await this.deps.store.saveState(
      cmd.tenant,
      cmd.profileId,
      stateCipher,
      capturedAt,
      storageStateDomains(state),
    );
    if (!updated) throw new NotFoundError("NOT_FOUND", { id: cmd.profileId }, "browser profile not found.");
    return updated;
  }
}

// Keep only the selected cookies. Domains match with the leading dot stripped — the same normalization the
// state preview applies, so the wizard's chips round-trip exactly.
function filterState(state: StorageState, selection: CookieSelection[]): StorageState {
  const keep = new Set(selection.map((s) => `${s.domain}|${s.name}`));
  return { cookies: state.cookies.filter((c) => keep.has(`${c.domain.replace(/^\./, "")}|${c.name}`)) };
}
