import type { EmitPlatformEventInput, PlatformEventEmitter } from "@everdict/application-control";

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
