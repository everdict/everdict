import {
  EVERDICT_SEMCONV as INTERNAL_SEMCONV,
  OTEL_SERVICE_NAME_ATTR as INTERNAL_SERVICE_NAME_ATTR,
} from "@everdict/trace";
import { describe, expect, it } from "vitest";
import {
  EVERDICT_SEMCONV,
  OTEL_SERVICE_NAME_ATTR,
  everdictExporterEnv,
  everdictExporterOptions,
  everdictResourceAttributes,
  everdictResourceAttributesEnv,
} from "./index.js";

describe("@everdict/otel — the user-facing OTLP-door configuration helpers (N2)", () => {
  it("the semconv copy stays in lockstep with the receiver's vocabulary (drift guard)", () => {
    // The user package is deliberately dependency-free, so the constants are duplicated — this test is
    // the lockstep: a receiver-side rename fails HERE before it strands a user.
    expect(EVERDICT_SEMCONV).toEqual(INTERNAL_SEMCONV);
    // The plane key is OTel's own attribute — the door groups by exactly this string.
    expect(OTEL_SERVICE_NAME_ATTR).toBe(INTERNAL_SERVICE_NAME_ATTR);
  });

  it("a SERVICE joins a run's system view by naming itself — OTel's own attribute, no everdict key", () => {
    // The multi-plane recipe: same run correlation, one service.name per process. The door then seals
    // each service as its own plane of the run's trajectory instead of mistaking it for a retry.
    expect(everdictResourceAttributes({ runId: "run-1", serviceName: "checkout" })).toEqual({
      "service.name": "checkout",
      "everdict.run_id": "run-1",
    });
    expect(everdictResourceAttributesEnv({ runId: "run-1", serviceName: "checkout" })).toBe(
      "service.name=checkout,everdict.run_id=run-1",
    );
  });

  it("builds resource attributes and their env rendering from one correlation", () => {
    const correlation = { runId: "run-1", kind: "agent", caseId: "c1" };
    expect(everdictResourceAttributes(correlation)).toEqual({
      "everdict.run_id": "run-1",
      "everdict.kind": "agent",
      "everdict.case_id": "c1",
    });
    expect(everdictResourceAttributesEnv(correlation)).toBe(
      "everdict.run_id=run-1,everdict.kind=agent,everdict.case_id=c1",
    );
  });

  it("builds the exporter env pair and the in-code options from one config (trailing slash normalized)", () => {
    const config = { endpoint: "https://everdict.acme.io/", apiKey: "ak_test" };
    expect(everdictExporterEnv(config)).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://everdict.acme.io",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer ak_test",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    });
    expect(everdictExporterOptions(config)).toEqual({
      url: "https://everdict.acme.io/v1/traces",
      headers: { Authorization: "Bearer ak_test" },
    });
  });
});
