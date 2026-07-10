import { VersionTagsBodySchema, setVersionTags } from "@everdict/application-control";
import { RuntimeSpecSchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { runtimeDocs } from "./runtime.docs.js";

// runtimes (workspace-owned SSOT, execution infra: local | nomad | k8s)
export function registerRuntimeRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/runtimes", { schema: runtimeDocs.register }, async (req, reply) => {
    if (!deps.runtimeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (execution infra = admin)
    }
    const parsed = RuntimeSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.runtimeRegistry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  app.post("/runtimes/validate", { schema: runtimeDocs.validate }, async (req, reply) => {
    if (!deps.runtimeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = RuntimeSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.runtimeRegistry.ownVersions(principal.workspace, parsed.data.id);
    // Referenced-secret existence check (warning): whether the spec's authSecret/kubeconfigSecret (names) exist in this workspace's SecretStore.
    // Surfaces before registration what previously failed silently only at dispatch time (not a hard failure — the secret can be added later).
    const referenced: string[] = [];
    if ("authSecret" in parsed.data && parsed.data.authSecret) referenced.push(parsed.data.authSecret);
    if (parsed.data.kind === "k8s" && parsed.data.kubeconfigSecret) referenced.push(parsed.data.kubeconfigSecret);
    let missingSecrets: string[] | undefined;
    if (deps.secretStore && referenced.length > 0) {
      const have = new Set((await deps.secretStore.list(principal.workspace)).map((s) => s.name));
      missingSecrets = referenced.filter((name) => !have.has(name));
    }
    return reply.send({
      ok: true,
      kind: parsed.data.kind,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
      ...(missingSecrets ? { missingSecrets } : {}),
    });
  });

  // Connection test (live) — unlike validate (schema), actually connects to the cluster to confirm reachability/auth (does not run a job).
  // The control plane resolves the credentials (authSecret/kubeconfigSecret) from secrets and uses them only as auth headers, never exposing them to the agent.
  app.post("/runtimes/probe", { schema: runtimeDocs.probe }, async (req, reply) => {
    if (!deps.probeRuntime) return reply.code(404).send({ code: "NOT_FOUND", message: "probe not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before live I/O)
    }
    const parsed = RuntimeSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await deps.probeRuntime(principal.workspace, parsed.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/runtimes", { schema: runtimeDocs.list }, async (req, reply) => {
    if (!deps.runtimeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runtimes:read");
      return reply.send(await deps.runtimeRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/runtimes/:id/versions/:version",
    { schema: runtimeDocs.get },
    async (req, reply) => {
      if (!deps.runtimeRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runtimes:read");
        return reply.send(await deps.runtimeRegistry.get(principal.workspace, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Replace version tags (whole-array PUT; empty array = clear) — mutable metadata outside the spec (free labels, to tell versions apart). Reuses runtimes:write.
  app.put<{ Params: { id: string; version: string } }>(
    "/runtimes/:id/versions/:version/tags",
    { schema: runtimeDocs.setVersionTags },
    async (req, reply) => {
      if (!deps.runtimeRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "runtime registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const parsed = VersionTagsBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await setVersionTags(
            deps.runtimeRegistry,
            principal,
            "runtimes:write",
            req.params.id,
            req.params.version,
            parsed.data.tags,
          ),
        );
      } catch (err) {
        return sendError(reply, err); // no permission 403 / not found·non-owned 404
      }
    },
  );
}
