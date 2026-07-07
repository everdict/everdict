import { z } from "zod";

// The desktop app's non-secret settings (autostart, etc.). The rnr_ pairing token is never kept here —
// it lives only in safeStorage encrypted storage (slice 3, skill desktop invariant 5).
export const DesktopConfigSchema = z.object({
  autostart: z.boolean().default(false),
  // The web (server) URL to connect to — saved from the first-run screen / tray 'change server address' (D8). Precedence vs env/CI defaults is in server-url.ts.
  webUrl: z.string().url().optional(),
  // Non-secret meta of the paired runner — the token is never here (token-store/safeStorage).
  runnerId: z.string().min(1).optional(),
  apiUrl: z.string().url().optional(),
  // Independent notifications (N6) cursor — the last OS-fired createdAt (ISO). Prevents re-firing the backlog on restart.
  notifyCursor: z.string().optional(),
});
export type DesktopConfig = z.infer<typeof DesktopConfigSchema>;

// File IO injection point — main wires in the real fs at the userData path, and tests substitute an in-memory one.
export interface ConfigIo {
  read(): string | null; // null if the file is absent
  write(text: string): void;
}

export function loadConfig(io: ConfigIo): DesktopConfig {
  const raw = io.read();
  if (raw === null) return DesktopConfigSchema.parse({});
  try {
    return DesktopConfigSchema.parse(JSON.parse(raw));
  } catch {
    // A corrupt config file must not block app startup — these are non-secret UI settings, so recover with defaults.
    return DesktopConfigSchema.parse({});
  }
}

export function saveConfig(io: ConfigIo, config: DesktopConfig): void {
  io.write(`${JSON.stringify(config, null, 2)}\n`);
}
