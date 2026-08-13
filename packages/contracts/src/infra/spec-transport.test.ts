import { describe, expect, it } from "vitest";
import { k8sTopologyTransport, nomadTopologyTransport, traceSourceTransport } from "./spec-transport.js";

// ── THE TRANSPORT CONFORMANCE SUITE ──────────────────────────────────────────────────────────────────
//
// Every builder here is asserted the same way: a FULLY-POPULATED spec arrives fully populated. That shape is
// the point. Testing "it forwards `datacenters`" fixes the field that was noticed; asserting that no declared
// field is missing fails the day somebody adds the next one, which is the class of defect this replaces —
// four literals, four drops, each individually invisible because the receiving options are all optional.
describe("spec transport — a spec crossing a boundary arrives whole", () => {
  it("nomad topology: every field the spec can express reaches the runtime", () => {
    const spec = {
      namespace: "evals",
      browserImage: "everdict/browser:1",
      hostGatewayAddr: "172.17.0.1",
      datacenters: ["dc-eu-1", "dc-eu-2"],
      runtime: "runsc",
      provisionDependencies: true,
    };
    const transported = nomadTopologyTransport(spec);
    for (const key of Object.keys(spec)) expect(transported).toHaveProperty(key);
    expect(transported.datacenters).toEqual(["dc-eu-1", "dc-eu-2"]);
    expect(transported.runtime).toBe("runsc");
    expect(transported.provisionDependencies).toBe(true);
  });

  it("nomad topology: an unset field is OMITTED, never sent as undefined", () => {
    // The receiver's own defaults have to survive — `{namespace: undefined}` is not the same as no namespace
    // once a downstream `??` is involved.
    expect(nomadTopologyTransport({})).toEqual({});
    expect(Object.keys(nomadTopologyTransport({ datacenters: ["dc1"] }))).toEqual(["datacenters"]);
  });

  it("k8s topology: the same, under the naming K8s uses", () => {
    const transported = k8sTopologyTransport({
      namespace: "evals",
      browserImage: "everdict/browser:1",
      hostGatewayAddr: "10.0.0.1",
      provisionDependencies: false,
    });
    expect(transported).toEqual({
      namespacePrefix: "evals",
      browserImage: "everdict/browser:1",
      hostGatewayAddr: "10.0.0.1",
      provisionDependencies: false,
    });
  });

  it("trace source: every declared field arrives, mapping included", () => {
    const spec = {
      kind: "mlflow" as const,
      endpoint: "https://mlflow.internal",
      authSecret: "MLFLOW_TOKEN",
      correlate: "tag" as const,
      correlateTag: "mlflow.trace.session",
      service: "planner",
      project: "evals",
      mapping: { messageText: ["mlflow.spanInputs"], screenshot: ["attachments.screenshot"] },
      artifactBaseUrl: "https://mlflow.internal/artifacts",
    };
    const config = traceSourceTransport(spec, "Bearer real-token");
    for (const key of Object.keys(spec)) {
      if (key === "authSecret") continue;
      expect(config).toHaveProperty(key);
    }
    expect(config.mapping).toEqual(spec.mapping);
    expect(config.correlateTag).toBe("mlflow.trace.session");
  });

  it("trace source: the SecretStore NAME never reaches the config, only the resolved value", () => {
    const config = traceSourceTransport(
      { kind: "otel", endpoint: "http://otel:4318", authSecret: "OTEL_TOKEN" },
      "Bearer real-token",
    );
    expect(JSON.stringify(config)).not.toContain("OTEL_TOKEN");
    expect(config.headers).toEqual({ authorization: "Bearer real-token" });
    // …and with nothing resolved there is no headers key at all, rather than an empty one.
    expect(traceSourceTransport({ kind: "otel", endpoint: "http://otel:4318", authSecret: "X" })).toEqual({
      kind: "otel",
      endpoint: "http://otel:4318",
    });
  });
});
