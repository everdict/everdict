import { AppError, EvalCaseSchema } from "@assay/core";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import type { RunService } from "./run-service.js";

// POST /runs 본문 — 외부 입력이라 Zod 검증.
export const SubmitBodySchema = z.object({
  harness: z.object({ id: z.string(), version: z.string() }),
  case: EvalCaseSchema,
  webhookUrl: z.string().url().optional(),
});

export interface ServerDeps {
  service: RunService;
  tenantHeader?: string; // 기본 x-assay-tenant
}

function tenantOf(headers: Record<string, unknown>, header: string): string {
  const v = headers[header];
  return typeof v === "string" && v.length > 0 ? v : "default";
}

// 컨트롤플레인 HTTP 표면. 비동기: POST /runs 는 202 + runId, 결과는 GET /runs/:id 폴링 또는 웹훅.
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const header = deps.tenantHeader ?? "x-assay-tenant";

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/runs", async (req, reply) => {
    let body: z.infer<typeof SubmitBodySchema>;
    try {
      body = SubmitBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    const tenant = tenantOf(req.headers as Record<string, unknown>, header);
    try {
      const record = await deps.service.submit({ tenant, ...body });
      return reply.code(202).send(record); // Accepted — 비동기
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const record = await deps.service.get(req.params.id);
    if (!record) return reply.code(404).send({ code: "NOT_FOUND", message: "run 을 찾을 수 없습니다." });
    return reply.send(record);
  });

  app.get("/runs", async (req, reply) => {
    const tenant = tenantOf(req.headers as Record<string, unknown>, header);
    return reply.send(await deps.service.list(tenant));
  });

  return app;
}

// AppError → 상태코드(402/404/429/…)로 매핑. 에러 봉투는 flat {code,message,data?} (digo-api 이디엄).
function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) {
    return reply.code(err.status).send(err.toEnvelope());
  }
  return reply.code(500).send({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
}
