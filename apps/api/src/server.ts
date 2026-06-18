import { timingSafeEqual } from "node:crypto";
import { type Action, type Authenticator, type Principal, authorize } from "@assay/auth";
import { AppError, EvalCaseSchema, HarnessSpecSchema } from "@assay/core";
import { type TenantKeyStore, issueKey } from "@assay/db";
import type { HarnessRegistry } from "@assay/registry";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { RunService } from "./run-service.js";

export const SubmitBodySchema = z.object({
  harness: z.object({ id: z.string(), version: z.string() }),
  case: EvalCaseSchema,
  webhookUrl: z.string().url().optional(),
});

export interface ServerDeps {
  service: RunService;
  registry?: HarnessRegistry; // 하니스 CRUD (없으면 해당 라우트 비활성)
  authenticator?: Authenticator; // 컨트롤플레인이 소유하는 인증(OIDC + API 키)
  keyStore?: TenantKeyStore; // /internal/tenant-keys 발급용
  internalToken?: string; // /internal/** 가드 (없으면 fail-closed)
  requireAuth?: boolean; // true 면 인증 필수(dev 폴백 금지)
  devTenantHeader?: string; // 미인증 dev 폴백 헤더 (기본 x-assay-tenant)
}

// 인증된 Principal 해석: Bearer(JWT 또는 ak_) → Authenticator. 미인증 dev 는 헤더 워크스페이스 + admin.
async function resolvePrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDeps,
): Promise<Principal | undefined> {
  const authz = req.headers.authorization;
  if (deps.authenticator && typeof authz === "string" && authz.startsWith("Bearer ")) {
    const principal = await deps.authenticator.authenticate(authz.slice(7).trim());
    if (!principal) {
      reply.code(401).send({ code: "UNAUTHENTICATED", message: "유효하지 않은 자격증명입니다." });
      return undefined;
    }
    return principal;
  }
  if (deps.requireAuth) {
    reply.code(401).send({ code: "UNAUTHENTICATED", message: "Authorization: Bearer <token|api-key> 가 필요합니다." });
    return undefined;
  }
  // dev 폴백: 헤더 워크스페이스, 풀 권한.
  const header = (req.headers as Record<string, unknown>)[deps.devTenantHeader ?? "x-assay-tenant"];
  const workspace = typeof header === "string" && header.length > 0 ? header : "default";
  return { subject: "dev", workspace, roles: ["admin"], via: "api-key" };
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// 컨트롤플레인 HTTP 표면. 인증은 컨트롤플레인이 소유(OIDC/JWT + API 키), workspace=tenant, authZ 강제.
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  // 현재 Principal — 웹/에이전트가 워크스페이스·역할을 확인(UI 게이팅 등).
  app.get("/me", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    return reply.send(principal);
  });

  // --- runs ---
  app.post("/runs", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    let body: z.infer<typeof SubmitBodySchema>;
    try {
      body = SubmitBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      gate(principal, "runs:submit");
      return reply.code(202).send(await deps.service.submit({ tenant: principal.workspace, ...body }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const record = await deps.service.get(req.params.id);
      if (!record || record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run 을 찾을 수 없습니다." });
      return reply.send(record);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/runs", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      return reply.send(await deps.service.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- harnesses (workspace-owned SSOT) ---
  app.post("/harnesses", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = HarnessSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "harnesses:register");
      await deps.registry.register(principal.workspace, parsed.data);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // 권한 없음 403 / 불변성 409
    }
  });

  app.get("/harnesses", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.registry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/harnesses/:id", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const versions = await deps.registry.versions(principal.workspace, req.params.id);
      if (versions.length === 0)
        return reply.code(404).send({ code: "NOT_FOUND", message: "하니스를 찾을 수 없습니다." });
      return reply.send({ id: req.params.id, versions });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- internal: 키 발급 (x-internal-token 가드, 미설정 시 fail-closed) ---
  app.post("/internal/tenant-keys", async (req, reply) => {
    if (!deps.internalToken || !deps.keyStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal 비활성" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token 불일치" });
    const body = z.object({ workspace: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const apiKey = await issueKey(deps.keyStore, body.data.workspace);
    return reply.code(201).send({ workspace: body.data.workspace, apiKey }); // 평문은 여기서 한 번만
  });

  return app;
}

// authorize 래퍼 — ForbiddenError 를 그대로 던져 sendError 가 403 으로 매핑.
function gate(principal: Principal, action: Action): void {
  authorize(principal, action);
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) return reply.code(err.status).send(err.toEnvelope());
  return reply.code(500).send({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
}
