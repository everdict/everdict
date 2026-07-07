import { z } from "zod";

// The main-process half of the window.everdictDesktop bridge — channel constants · payload validation · origin guard · handler registration.
// The channel strings are manually kept in sync with preload.cts (preload is CJS and cannot import this module).
// Skill desktop invariant 3 (the four methods are all there is) · 4 (the permission boundary is the IPC origin check).
export const BRIDGE_CHANNELS = {
  appInfo: "everdict:app-info",
  pair: "everdict:pair-runner",
  unpair: "everdict:unpair-runner",
  status: "everdict:runner-status",
  statusEvent: "everdict:runner-status-event",
} as const;

// The pairing payload the web (bridge caller) passes — boundary Zod validation. The token arrives via this path and is stored only in the keychain.
export const PairPayloadSchema = z.object({
  token: z.string().startsWith("rnr_"),
  runnerId: z.string().min(1).optional(),
  apiUrl: z.string().url().optional(),
});
export type PairPayload = z.infer<typeof PairPayloadSchema>;

// The runner status shown to the web — manually kept in sync with the apps/web `shared/lib/desktop-bridge.ts` mirror (the web does not depend on @everdict/*).
export interface DesktopRunnerStatus {
  paired: boolean;
  runnerId?: string;
  state: "off" | "idle" | "running";
  activeJobs: number;
  capabilities: string[];
}

export interface DesktopAppInfo {
  version: string;
  platform: string;
  hostname: string;
  capabilities: string[];
}

// Validate the IPC sender frame origin — the real boundary of bridge permission (enforced here, not by the navigation policy).
export function senderAllowed(frameUrl: string | undefined, webOrigin: string): boolean {
  if (!frameUrl) return false;
  try {
    return new URL(frameUrl).origin === webOrigin;
  } catch {
    return false;
  }
}

// The minimal surface of electron ipcMain — tests inject a fake (no electron value import).
interface InvokeEventLike {
  senderFrame: { url: string } | null;
}
export interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEventLike, payload: unknown) => unknown): void;
}

export interface BridgeDeps {
  // Always re-read the current web origin (D8: the server address can change at runtime). null = server not configured → block everything.
  webOrigin(): string | null;
  appInfo(): Promise<DesktopAppInfo>;
  pair(payload: PairPayload): Promise<void>;
  unpair(): Promise<void>;
  status(): DesktopRunnerStatus;
}

export function registerBridge(ipc: IpcMainLike, deps: BridgeDeps): void {
  const guarded =
    (handler: (payload: unknown) => unknown) =>
    (event: InvokeEventLike, payload: unknown): unknown => {
      const origin = deps.webOrigin();
      if (origin === null || !senderAllowed(event.senderFrame?.url, origin))
        throw new Error("Bridge call from a disallowed origin.");
      return handler(payload);
    };
  ipc.handle(
    BRIDGE_CHANNELS.appInfo,
    guarded(() => deps.appInfo()),
  );
  ipc.handle(
    BRIDGE_CHANNELS.pair,
    guarded((payload) => deps.pair(PairPayloadSchema.parse(payload))),
  );
  ipc.handle(
    BRIDGE_CHANNELS.unpair,
    guarded(() => deps.unpair()),
  );
  ipc.handle(
    BRIDGE_CHANNELS.status,
    guarded(() => deps.status()),
  );
}
