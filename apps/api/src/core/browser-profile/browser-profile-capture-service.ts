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

export interface CaptureCommand {
  tenant: string;
  profileId: string;
  sessionId: string;
  subject: string;
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

    const state = await this.capture(cdpBase);
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
