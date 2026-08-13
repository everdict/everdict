import { UpstreamError } from "@everdict/contracts";
import { type CdpSocket, type CdpTarget, pickPageTarget } from "./capture-cdp.js";
import { reachableWsUrl } from "./cdp-ws.js";

// ── A LISTED TARGET IS A CANDIDATE, NOT A PAGE ───────────────────────────────────────────────────────
//
// `GET /json/close/<id>` answers 200 while the target is STILL ADVERTISED — measured at roughly 205ms of
// lingering presence in `/json`. Every selection site in this codebase took the listing as ground truth, so
// a tab closed just before a lease was handed out as the session's page. Opening a WS to that ghost is the
// worst possible failure: the socket OPENS in about 2ms and then never replies. Not an error — a silence,
// which each caller eventually reports as its own timeout.
//
// TWO OBVIOUS FIXES ARE DISPROVEN, and are written down so they are not re-driven: `Target.getTargets` lags
// identically (it still INCLUDES the closed target), and `Target.attachToTarget(<dead>, {flatten:true})`
// SUCCEEDS with a fresh sessionId in about 5ms. Neither a better listing API nor an attach probe tells a
// live target from a closed one. What discriminates is asking the target itself a question and requiring an
// answer — one round trip, on a budget well over the observed linger.

const DEFAULT_PROBE_MS = 500; // well over the ~205ms measured linger, well under any caller's own timeout

function defaultConnect(url: string): CdpSocket {
  return new WebSocket(url) as unknown as CdpSocket;
}

export interface LiveTargetOptions {
  fetch?: typeof fetch;
  connect?: (url: string) => CdpSocket;
  probeMs?: number;
}

// Ask ONE question of a target and require an answer. `Page.getFrameTree` is chosen because every live page
// answers it and a closed one cannot — the reply's content is irrelevant, its ARRIVAL is the signal.
export async function targetAnswers(
  target: CdpTarget,
  cdpHttpBase: string,
  opts: LiveTargetOptions = {},
): Promise<boolean> {
  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) return false;
  const connect = opts.connect ?? defaultConnect;
  const budget = opts.probeMs ?? DEFAULT_PROBE_MS;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let ws: CdpSocket;
    const done = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // closing is best-effort — the probe's verdict is already decided
      }
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), budget);
    try {
      ws = connect(reachableWsUrl(wsUrl, cdpHttpBase));
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Page.getFrameTree" })));
    ws.addEventListener("message", () => done(true));
    ws.addEventListener("error", () => done(false));
  });
}

// The listing's preferred page, then the rest — the FIRST that answers. Order still comes from pickPageTarget
// (most-recently-active, non-blank preferred), because probing decides liveness and not which tab is the work
// surface.
export async function pickLivePageTarget(
  targets: CdpTarget[],
  cdpHttpBase: string,
  opts: LiveTargetOptions = {},
): Promise<CdpTarget | undefined> {
  const preferred = pickPageTarget(targets);
  const candidates = [
    ...(preferred ? [preferred] : []),
    ...targets.filter((t) => t !== preferred && t.webSocketDebuggerUrl),
  ];
  for (const candidate of candidates) {
    if (await targetAnswers(candidate, cdpHttpBase, opts)) return candidate;
  }
  return undefined;
}

// Guarantee the browser has a page target that ANSWERS, creating one if the listing holds only ghosts. The
// re-list matters: `/json/new` returns before the target is listed on some builds, and a stale listing is
// exactly what this function exists to distrust.
export async function ensureLivePageTarget(cdpHttpBase: string, opts: LiveTargetOptions = {}): Promise<CdpTarget> {
  const fetchImpl = opts.fetch ?? fetch;
  const list = async (): Promise<CdpTarget[]> => {
    const res = await fetchImpl(`${cdpHttpBase}/json`);
    if (!res.ok) return [];
    return (await res.json()) as CdpTarget[];
  };
  const live = await pickLivePageTarget(await list(), cdpHttpBase, opts);
  if (live) return live;
  await fetchImpl(`${cdpHttpBase}/json/new?about:blank`, { method: "PUT" }).catch(() => undefined);
  const created = await pickLivePageTarget(await list(), cdpHttpBase, opts);
  if (created) return created;
  throw new UpstreamError(
    "UPSTREAM_ERROR",
    { cdpHttpBase },
    "This browser lists page targets but none of them answers — every listed target is closed or hung.",
  );
}
