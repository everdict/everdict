import { BadRequestError } from "@everdict/core";

// Deployment policy (default): a run must state "where it runs" — a registered tenant runtime id or a self-hosted runner
// (self:<id> / self:ws[:<id>]). A silent fallback to the control-plane host in-process (LocalBackend) is forbidden (so that
// untrusted eval code never runs on an unisolated host). This is fixed API behavior, not an opt-in env — main.ts never registers
// LocalBackend at all and keeps this gate always on for both services.
//
// target = the placement runtime id or the case's placement.target. All three (registered runtime / self:<id> / self:ws) ride on this
// string (RuntimeDispatcher routes on that value). So here we only check "is it non-empty" — the value's validity (existence) is
// handled as NOT_FOUND by RuntimeDispatcher/Scheduler at dispatch time. Submit-time fail-fast blocks only the silent local fallback.
//
// The enforce argument is a wiring signal, not an env toggle: the API (main.ts) is always true (local unregistered). Service unit tests
// inject a mock dispatcher directly and have no backend concept, so it defaults to false (unset) — this is to not break the Dispatcher abstraction.
export function assertRuntimeTarget(enforce: boolean | undefined, target: string | undefined): void {
  if (!enforce) return; // test/abstract path — gate not applied (the caller owns the dispatcher directly)
  if (target?.trim()) return;
  throw new BadRequestError(
    "BAD_REQUEST",
    {},
    "This deployment requires you to specify a runtime — a registered runtime id or self:<runner> (self:ws). The local (control-plane host in-process) fallback is disabled.",
  );
}
