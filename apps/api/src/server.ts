import { timingSafeEqual } from "node:crypto";
import { AppError, EvalCaseSchema, HarnessSpecSchema } from "@assay/core";
import { type TenantAuth, type TenantKeyStore, issueKey } from "@assay/db";
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
  auth?: TenantAuth; // Bearer 키 → tenant
  keyStore?: TenantKeyStore; // /internal/tenant-keys 발급용
  internalToken?: string; // /internal/** 가드 (없으면 fail-closed)
  requireAuth?: boolean; // true 면 Bearer 필수(헤더 폴백 금지)
  tenantHeader?: string; // dev 폴백 헤더 (기본 x-assay-tenant)
}

function headerTenant(req: FastifyRequest, header: string): string {
  const v = (req.headers as Record<string, unknown>)[header];
  return typeof v === "string" && v.length > 0 ? v : "default";
}

// 인증된 tenant 해석: Bearer 키 우선, 없으면(requireAuth=false) dev 헤더 폴백. 실패 시 401 전송 후 undefined.
async function resolveTenant(req: FastifyRequest, reply: FastifyReply, deps: ServerDeps): Promise<string | undefined> {
  const authz = req.headers.authorization;
  if (deps.auth && typeof authz === "string" && authz.startsWith("Bearer ")) {
    const tenant = await deps.auth.authenticate(authz.slice(7).trim());
    if (!tenant) {
      reply.code(401).send({ code: "UNAUTHORIZED", message: "유효하지 않은 API 키입니다." });
      return undefined;
    }
    return tenant;
  }
  if (deps.requireAuth) {
    reply.code(401).send({ code: "UNAUTHORIZED", message: "Authorization: Bearer <api-key> 가 필요합니다." });
    return undefined;
  }
  return headerTenant(req, deps.tenantHeader ?? "x-assay-tenant");
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// 컨트롤플레인 HTTP 표면. 비동기: POST /runs 는 202+runId. 멀티테넌트: tenant 는 Bearer 키에서 파생.
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  // --- runs ---
  app.post("/runs", async (req, reply) => {
    const tenant = await resolveTenant(req, reply, deps);
    if (!tenant) return reply;
    let body: z.infer<typeof SubmitBodySchema>;
    try {
      body = SubmitBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(202).send(await deps.service.submit({ tenant, ...body }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const tenant = await resolveTenant(req, reply, deps);
    if (!tenant) return reply;
    const record = await deps.service.get(req.params.id);
    // 테넌트 스코핑: 자기 run 만 조회 가능.
    if (!record || record.tenant !== tenant)
      return reply.code(404).send({ code: "NOT_FOUND", message: "run 을 찾을 수 없습니다." });
    return reply.send(record);
  });

  app.get("/runs", async (req, reply) => {
    const tenant = await resolveTenant(req, reply, deps);
    if (!tenant) return reply;
    return reply.send(await deps.service.list(tenant));
  });

  // --- harnesses (tenant-owned SSOT) ---
  app.post("/harnesses", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const tenant = await resolveTenant(req, reply, deps);
    if (!tenant) return reply;
    const parsed = HarnessSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.registry.register(tenant, parsed.data);
      return reply.code(201).send({ tenant, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // 불변성 위반 → 409
    }
  });

  app.get("/harnesses", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const tenant = await resolveTenant(req, reply, deps);
    if (!tenant) return reply;
    return reply.send(await deps.registry.list(tenant));
  });

  app.get<{ Params: { id: string } }>("/harnesses/:id", async (req, reply) => {
    if (!deps.registry) return reply.code(404).send({ code: "NOT_FOUND", message: "registry 미설정" });
    const tenant = await resolveTenant(req, reply, deps);
    if (!tenant) return reply;
    const versions = await deps.registry.versions(tenant, req.params.id);
    if (versions.length === 0)
      return reply.code(404).send({ code: "NOT_FOUND", message: "하니스를 찾을 수 없습니다." });
    return reply.send({ id: req.params.id, versions });
  });

  // --- internal: 키 발급 (x-internal-token 가드, 미설정 시 fail-closed) ---
  app.post("/internal/tenant-keys", async (req, reply) => {
    if (!deps.internalToken || !deps.keyStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal 비활성" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token 불일치" });
    const body = z.object({ tenant: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const apiKey = await issueKey(deps.keyStore, body.data.tenant);
    return reply.code(201).send({ tenant: body.data.tenant, apiKey }); // 평문은 여기서 한 번만
  });

  return app;
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) return reply.code(err.status).send(err.toEnvelope());
  return reply.code(500).send({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
}
