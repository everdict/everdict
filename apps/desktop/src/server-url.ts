// Resolve the web (server) URL the desktop will render — a pure function (no electron dependency). Design D8 (docs/architecture/desktop-app.md):
// a packaged app must know which server to connect to in order to reach the login screen. Precedence:
//   env EVERDICT_WEB_URL (dev/e2e override) > config.json webUrl (saved by the user at first run / from the tray)
//   > CI-injected default (esbuild define — bakes the deployment URL into release builds). If all absent, null → the setup screen.
export function normalizeWebUrl(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString().replace(/\/$/, "");
}

export interface WebUrlSources {
  envUrl?: string | undefined;
  configUrl?: string | undefined;
  bakedUrl?: string | undefined;
}

export function resolveWebUrl(sources: WebUrlSources): string | null {
  return normalizeWebUrl(sources.envUrl) ?? normalizeWebUrl(sources.configUrl) ?? normalizeWebUrl(sources.bakedUrl);
}
