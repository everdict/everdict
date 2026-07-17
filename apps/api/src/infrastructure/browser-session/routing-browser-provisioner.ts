import type {
  BrowserSessionProvisioner,
  ProvisionBrowserOptions,
  ProvisionedBrowser,
} from "../../common/browser-session-provisioner.js";

// Routes a session's browser to WHERE it should run (browser-profiles S9). No `runtime` in the options ⇒ the
// control-plane host provisioner (the S1 host-Chrome / S6 host-Docker default, for dev / self-hosted); a `runtime`
// id ⇒ the runtime provisioner, which stands the browser up on the tenant's registered runtime inside that tenant's
// trust zone (per-tenant network isolation). Keeps the `BrowserSessionProvisioner` port unchanged for the service.
export class RoutingBrowserProvisioner implements BrowserSessionProvisioner {
  constructor(
    private readonly host: BrowserSessionProvisioner,
    private readonly runtime: BrowserSessionProvisioner,
  ) {}

  provision(opts?: ProvisionBrowserOptions): Promise<ProvisionedBrowser> {
    return opts?.runtime ? this.runtime.provision(opts) : this.host.provision(opts);
  }
}
