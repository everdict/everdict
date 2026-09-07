import { NotFoundError } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildSandboxSessions } from "./sandbox.js";

// ── A HARNESS REGISTRY OUTAGE WAS SPENT AS "YOU NEVER REGISTERED THAT" ───────────────────────────────
//
// Both session resolvers in `composition/sandbox.ts` read the workspace's harness registry the same way:
//
//     const spec = harnesses
//       ? await harnesses.get(tenant, ref.id, ref.version ?? "latest").catch(() => undefined)
//       : undefined;
//
// `HarnessInstanceRegistry.get` returns a resolved `HarnessSpec` and throws `NotFoundError` when the
// workspace has no such harness. That is one of three answers, and the catch collapses the other two into
// it: a Postgres failover, an unreadable row, a network partition all arrive at this line as "not
// registered". This is the literal shape rule `protocol` L2 forbids, found by `pnpm scan` over files nobody
// had touched.
//
// The two lanes lose different things, and the second one is why this is not merely a wrong status code.
//
//   · the SERVICE-CONVERSATION resolver returns undefined, so the ref falls through to the process
//     resolver and a registered service harness answers 404 while the store is merely unreachable.
//   · the SESSION resolver keeps going with `spec === undefined`, and `makeHarness(id, version, undefined,
//     …)` does not refuse that — read it: a `spec?.kind === "command"` miss falls into a switch on the id,
//     and `claude-code` returns a `ClaudeCodeHarness` with none of the instance's env, pins or model
//     binding. So a workspace whose registered `claude-code` instance pins a model and an env booted the
//     bare built-in instead, provisioned a container for it, and billed the session — with nothing in the
//     record saying the registry had not been read. A 404 is visible; this is not.
//
// The repair is L2's: only `NotFoundError` is a permanent answer, and every other throw leaves this seam.
//
// ⚠️ WHAT THESE PIN. All four drive the production composition (`buildSandboxSessions` → the real
// `SandboxSessionService`), because the defect is in the closures that root builds and a test calling them
// directly would be testing a helper. The first two are the refused class; the last two are the ADMITTED
// one, and they are here because a refusal tested only from the refusing side has an unmeasured
// false-positive rate. `NotFoundError` still has to mean what it meant: a built-in the workspace never
// registered still boots, and a ref that is neither registered nor built-in still answers 404 rather than
// the 500 a blanket rethrow would have produced.

const OUTAGE = "harness registry unavailable";

const registryThatCannotBeRead = () => ({
  async get() {
    throw new Error(OUTAGE);
  },
});

const registryWithNothingRegistered = () => ({
  async get(_tenant: string, id: string) {
    throw new NotFoundError("NOT_FOUND", { harness: id }, `Harness '${id}' is not registered.`);
  },
});

const sessions = (opts: {
  harnesses: unknown;
  provision: () => Promise<never>;
  // Wiring the topology seam is what turns the service-conversation resolver on; without it a harness ref
  // goes straight to the session resolver, which is how these two cases reach one lane each.
  serviceConversations: boolean;
}) => {
  const service = buildSandboxSessions({
    store: {
      async liveSessions() {
        return [];
      },
    },
    deployment: { sandboxes: true },
    compute: {
      defaultCompute: { id: "test-driver", provision: opts.provision },
      async computeFor() {
        return undefined;
      },
      async resolve() {
        return undefined;
      },
    },
    harnesses: opts.harnesses,
    // The tiered shape `harnessAuthEnv` actually reads (`workspace` then `user`) — a bare `{}` here made the
    // first draft of this file red on a property access instead of on the invariant, which proves nothing.
    scopedSecretsFor: async () => ({ workspace: {}, user: {} }),
    ...(opts.serviceConversations
      ? {
          async topologyConversationEnvironmentFor() {
            throw new Error("a topology was built over a registry that could not be read");
          },
        }
      : {}),
  } as never);
  if (service === undefined) throw new Error("the sandbox lane did not build — the fixture is wrong, not the code");
  return service;
};

const CREATE = {
  tenant: "acme",
  createdBy: "user-1",
  // An image is named so the pre-fix path has everything it needs to reach `provision`. Without one the
  // session refuses for a different reason and the assertion below would be green over the wrong refusal.
  harness: { id: "claude-code", image: "ghcr.io/acme/env:1" },
};

describe("a harness registry that could not be read is not a harness nobody registered", () => {
  it("refuses the session instead of booting the built-in adapter with none of the instance's configuration", async () => {
    const provision = vi.fn(async (): Promise<never> => {
      throw new Error("a container was provisioned over a registry that could not be read");
    });
    const service = sessions({
      harnesses: registryThatCannotBeRead(),
      provision,
      serviceConversations: false,
    });

    await expect(service.create(CREATE), "a registry outage was spent as the workspace's own 404").rejects.toThrow(
      OUTAGE,
    );
    // The sharper half: pre-fix the read failure did not even produce a refusal — it produced a DIFFERENT
    // harness, and the session was on its way to a container.
    expect(provision, "a session booted the bare built-in while the registry was unreachable").not.toHaveBeenCalled();
  });

  it("refuses a service-harness conversation instead of falling through to the process resolver", async () => {
    const provision = vi.fn(async (): Promise<never> => {
      throw new Error("a container was provisioned over a registry that could not be read");
    });
    const service = sessions({
      harnesses: registryThatCannotBeRead(),
      provision,
      serviceConversations: true,
    });

    await expect(
      service.create(CREATE),
      "the conversation resolver read an outage as 'this is not a service harness'",
    ).rejects.toThrow(OUTAGE);
    expect(provision).not.toHaveBeenCalled();
  });

  it("still boots a built-in that no workspace ever registered", async () => {
    const provision = vi.fn(async (): Promise<never> => {
      throw new Error("reached the driver");
    });
    const service = sessions({
      harnesses: registryWithNothingRegistered(),
      provision,
      serviceConversations: false,
    });

    // THE ADMITTED CLASS, and the reason the repair narrows to `NotFoundError` rather than refusing every
    // throw. `makeHarness` builds `claude-code` from an id alone, so "this workspace registered no instance"
    // is a supported answer here — a repair that let the registry's own 404 escape would have taken the
    // built-in playground away from every workspace that never registered one.
    await expect(service.create(CREATE)).rejects.toThrow("reached the driver");
    expect(provision, "the built-in lane stopped booting").toHaveBeenCalled();
  });

  it("answers 404 for a harness that is neither registered nor a built-in", async () => {
    const provision = vi.fn(async (): Promise<never> => {
      throw new Error("a container was provisioned for a harness that does not exist");
    });
    const service = sessions({
      harnesses: registryWithNothingRegistered(),
      provision,
      serviceConversations: false,
    });

    await expect(
      service.create({ ...CREATE, harness: { id: "acme-cli", image: "ghcr.io/acme/env:1" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(provision).not.toHaveBeenCalled();
  });
});
