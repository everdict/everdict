import type { EmitPlatformEventInput, IssueBacklinkPort, PlatformEventEmitter } from "@everdict/application-control";

// Construction-order forwarder (E2): fact producers built BEFORE the platform-event service exists — the
// registries, the RevisionedWorkspaceFs decorator, the knowledge service — emit through this; bind() connects
// it once buildIntegrations has produced the real service. A fact emitted before bind is dropped, which only
// covers boot-time writes (and _shared seed registrations never emit at all). Same late-binding idiom as the
// cascade-cancel holder in main.ts.
export interface LateBoundEmitter extends PlatformEventEmitter {
  bind(target: PlatformEventEmitter): void;
}

export function lateBoundEmitter(): LateBoundEmitter {
  let target: PlatformEventEmitter | undefined;
  return {
    bind(t: PlatformEventEmitter): void {
      target = t;
    },
    async emit(input: EmitPlatformEventInput): Promise<unknown> {
      return target?.emit(input);
    },
    async pushPersisted(events) {
      return target?.pushPersisted?.(events);
    },
  };
}

// The same construction-order idiom for the issue backlink: the registries are decorated long before
// IssueService exists, so `withOriginBacklink` links through this forwarder and bind() connects it once the
// tracker services are built. Unbound = no link, which only covers boot-time registrations (seeds, whose
// `_shared` tenant the decorator skips anyway).
export interface LateBoundIssueLinker extends IssueBacklinkPort {
  bind(target: IssueBacklinkPort): void;
}

export function lateBoundIssueLinker(): LateBoundIssueLinker {
  let target: IssueBacklinkPort | undefined;
  return {
    bind(t: IssueBacklinkPort): void {
      target = t;
    },
    async link(tenant, id, input, actor): Promise<unknown> {
      return target?.link(tenant, id, input, actor);
    },
  };
}
