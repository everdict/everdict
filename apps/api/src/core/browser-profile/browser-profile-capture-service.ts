import type { BrowserProfileStore } from "@everdict/application-control";
import { BadRequestError, type BrowserProfileRecord, ForbiddenError, NotFoundError } from "@everdict/contracts";
import type { SecretCipher } from "@everdict/db";
import {
  type StorageState,
  captureStorageState,
  seedStorageState,
  storageStateDomains,
  storageStateExpiry,
} from "@everdict/topology";

// The profile ⇄ session bridge (browser-profiles). Two inverse operations. The profile is gated by the same rule as
// BrowserProfileService management: a `private` profile is creator-only (a non-creator 404s — invisible, no admin
// override); a `workspace` profile is creator-or-admin (a non-manager 403s). A profile in another workspace 404s. The
// interactive session stays owner-only regardless (a foreign session 400s — you can only drive your own live browser):
//   captureInto (S3) — read the session's cookies → encrypt → persist on the profile.
//   restoreInto      — decrypt the profile's saved cookies → seed them into the session (warm re-login): re-logging
//                      into a profile no longer starts from a blank browser. If the saved login is still valid the
//                      caller lands already signed-in; if it lapsed the site still recognizes the device, so re-auth
//                      is lighter. The decrypted blob stays server-side (only the domains to re-visit are returned).
export interface BrowserProfileCaptureServiceDeps {
  store: BrowserProfileStore;
  // The interactive session's reachable CDP base — an injected callback, NOT the peer BrowserSessionService (a core
  // service must not call another core service; cross-resource data arrives via a callback/store/registry).
  resolveCdpBase: (sessionId: string, subject: string) => string | undefined;
  cipher: SecretCipher;
  capture?: (cdpBase: string) => Promise<StorageState>; // injectable (tests); default = real CDP capture
  seed?: (cdpBase: string, state: StorageState) => Promise<void>; // injectable (tests); default = real CDP seed
  now?: () => string;
}

export interface RestoreCommand {
  tenant: string;
  profileId: string;
  sessionId: string;
  subject: string;
  isAdmin: boolean; // creator-override on the workspace-scoped profile (the session is always the caller's own)
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
  isAdmin: boolean; // creator-override on the workspace-scoped profile (the session is always the caller's own)
  cookies?: CookieSelection[]; // absent = keep everything the session holds
}

export class BrowserProfileCaptureService {
  private readonly capture: (cdpBase: string) => Promise<StorageState>;
  private readonly seed: (cdpBase: string, state: StorageState) => Promise<void>;
  private readonly now: () => string;

  constructor(private readonly deps: BrowserProfileCaptureServiceDeps) {
    this.capture = deps.capture ?? ((cdpBase) => captureStorageState(cdpBase));
    this.seed = deps.seed ?? ((cdpBase, state) => seedStorageState(cdpBase, state));
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // Per-visibility gate the profile + resolve the session's reachable CDP base — the shared preamble of
  // capture/restore. A `private` profile is creator-only (a non-creator 404s — invisible, no admin override); a
  // `workspace` profile is creator-or-admin (a non-manager 403s); a profile in another workspace 404s; an
  // inactive/foreign session is a 400 (the session is always the caller's own).
  private async resolve(cmd: {
    tenant: string;
    profileId: string;
    sessionId: string;
    subject: string;
    isAdmin: boolean;
  }): Promise<{ profile: BrowserProfileRecord; cdpBase: string }> {
    const profile = await this.deps.store.get(cmd.tenant, cmd.profileId);
    if (!profile) throw new NotFoundError("NOT_FOUND", { id: cmd.profileId }, "browser profile not found.");
    if (profile.visibility === "private") {
      if (profile.createdBy !== cmd.subject)
        throw new NotFoundError("NOT_FOUND", { id: cmd.profileId }, "browser profile not found.");
    } else if (profile.createdBy !== cmd.subject && !cmd.isAdmin) {
      throw new ForbiddenError(
        "FORBIDDEN",
        { id: cmd.profileId },
        "Only the profile's creator or a workspace admin can manage this shared browser profile.",
      );
    }
    const cdpBase = this.deps.resolveCdpBase(cmd.sessionId, cmd.subject);
    if (!cdpBase)
      throw new BadRequestError(
        "BAD_REQUEST",
        { sessionId: cmd.sessionId },
        "browser session not found or no longer active.",
      );
    return { profile, cdpBase };
  }

  // Warm re-login: seed the profile's saved cookies into the live session so the owner re-logs in from their prior
  // state instead of a blank browser. Best-effort by nature — an empty profile (nothing captured yet) is a no-op,
  // and stale cookies simply don't authenticate. Returns the domains the profile carries so the wizard can jump the
  // browser straight to them. The decrypted cookies go into the browser, never back to the client.
  async restoreInto(cmd: RestoreCommand): Promise<{ domains: string[] }> {
    const { profile, cdpBase } = await this.resolve(cmd);
    const blob = await this.deps.store.loadState(cmd.tenant, cmd.profileId);
    if (!blob) return { domains: profile.cookieDomains }; // no login captured yet — nothing to seed
    const state = JSON.parse(this.deps.cipher.decrypt(JSON.parse(blob))) as StorageState;
    await this.seed(cdpBase, state);
    return { domains: profile.cookieDomains };
  }

  async captureInto(cmd: CaptureCommand): Promise<BrowserProfileRecord> {
    const { cdpBase } = await this.resolve(cmd);
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
    // The profile's expected expiry = the earliest cookie expiry (unix seconds → ISO), or null when the login is
    // session-only. Persisted as plain metadata (not the cookie values) so Settings can surface staleness.
    const expirySeconds = storageStateExpiry(state);
    const expiresAt = expirySeconds !== null ? new Date(expirySeconds * 1000).toISOString() : null;
    const updated = await this.deps.store.saveState(
      cmd.tenant,
      cmd.profileId,
      stateCipher,
      capturedAt,
      storageStateDomains(state),
      expiresAt,
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
