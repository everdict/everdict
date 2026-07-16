// A dedicated interactive browser for an authenticated-profile login session (browser-profiles S1). This is NOT an
// eval — there is no case — so the browser is provisioned on its own, keyed by a browser-session id, and torn down
// on close/TTL. The port abstracts WHERE the browser runs: the S1 impl launches a host Chrome (self-hosted / local
// reachable path — apps/api can reach its CDP directly); managed Docker/K8s provisioners are later slices that
// return the same handle. See docs/architecture/browser-profiles.md.
export interface ProvisionedBrowser {
  // CDP HTTP base reachable from the control plane (e.g. http://127.0.0.1:<port>) — fed to openBrowserSession.
  cdpBase: string;
  // Tear the browser down (best-effort). Called on session close and on TTL sweep.
  dispose(): Promise<void>;
}

export interface ProvisionBrowserOptions {
  // Egress proxy for the login browser (Chrome --proxy-server) — resolved from the workspace's per-country pool
  // (browser-profiles S4). Absent = a direct connection.
  proxyServer?: string;
}

export interface BrowserSessionProvisioner {
  // Bring up a dedicated interactive browser and return its reachable CDP base + a disposer.
  provision(opts?: ProvisionBrowserOptions): Promise<ProvisionedBrowser>;
}
