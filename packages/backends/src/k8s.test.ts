import { RESULT_SENTINEL } from "@assay/agent";
import { type AgentJob, BadRequestError, type CaseResult, UpstreamError } from "@assay/core";
import { describe, expect, it } from "vitest";
import { type K8sApi, K8sBackend, buildK8sJob, k8sJobName } from "./k8s.js";
import { staticSecrets } from "./secrets.js";
import { perTenantTrustZones, staticTrustZones } from "./trust-zone.js";

const JOB: AgentJob = {
  harness: { id: "aider", version: "latest" },
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [{ id: "steps" }],
    timeoutSec: 60,
    tags: [],
  },
};
const RESULT: CaseResult = {
  caseId: "c1",
  harness: "aider@latest",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "abc" },
  scores: [{ graderId: "steps", metric: "tool_calls", value: 0 }],
};

interface JobManifest {
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    template: {
      spec: {
        runtimeClassName?: string;
        containers: Array<{ image: string; imagePullPolicy: string; env: Array<{ name: string; value: string }> }>;
      };
    };
  };
}
const envOf = (m: JobManifest, k: string) => m.spec.template.spec.containers[0]?.env.find((e) => e.name === k)?.value;

function mockApi(opts: { logs?: string; failed?: boolean; active?: number } = {}) {
  const applied: JobManifest[] = [];
  const deleted: string[] = [];
  let polls = 0;
  const api: K8sApi = {
    async ensureNamespace() {},
    async applyJob(m) {
      applied.push(m as JobManifest);
    },
    async jobStatus() {
      polls++;
      if (opts.failed) return { succeeded: 0, failed: 1 };
      return polls >= 2 ? { succeeded: 1, failed: 0 } : { succeeded: 0, failed: 0 };
    },
    async podLogs() {
      return opts.logs ?? `prelude\n${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n`;
    },
    async deleteJob(name) {
      deleted.push(name);
    },
    async countActiveJobs() {
      return opts.active ?? 3;
    },
  };
  return { api, applied, deleted };
}

describe("buildK8sJob / k8sJobName", () => {
  it("이미지·풀폴리시·잡 페이로드(ASSAY_AGENT_JOB)·네임스페이스를 담는다", () => {
    const m = buildK8sJob(JOB, { image: "reg/assay-agent:1" }, "assay-c1", "assay-acme") as unknown as JobManifest;
    expect(m.metadata.namespace).toBe("assay-acme");
    expect(m.spec.template.spec.containers[0]?.image).toBe("reg/assay-agent:1");
    expect(m.spec.template.spec.containers[0]?.imagePullPolicy).toBe("IfNotPresent");
    expect(m.spec.template.spec.runtimeClassName).toBeUndefined();
    const decoded = JSON.parse(Buffer.from(envOf(m, "ASSAY_AGENT_JOB") ?? "", "base64").toString("utf8"));
    expect(decoded.harness.id).toBe("aider");
  });

  it("job.judge 가 있으면 judge 모델 env 를 파드에 주입한다(키는 secretEnv)", () => {
    const m = buildK8sJob(
      { ...JOB, judge: { model: "gpt-5.4-mini" } },
      { image: "img", secretEnv: { OPENAI_API_KEY: "k" } },
      "n",
      "ns",
    ) as unknown as JobManifest;
    expect(envOf(m, "ASSAY_JUDGE_MODEL")).toBe("gpt-5.4-mini");
    expect(envOf(m, "OPENAI_API_KEY")).toBe("k");
    const off = buildK8sJob(JOB, { image: "img" }, "n", "ns") as unknown as JobManifest;
    expect(envOf(off, "ASSAY_JUDGE_MODEL")).toBeUndefined();
  });

  it("runtimeClassName 이 주어지면 파드 스펙에 실린다", () => {
    const m = buildK8sJob(JOB, { image: "img" }, "n", "ns", "gvisor") as unknown as JobManifest;
    expect(m.spec.template.spec.runtimeClassName).toBe("gvisor");
  });

  it("hostNetwork 옵션이 파드 스펙에 실린다(dev: 호스트 서비스 접근용)", () => {
    const m = buildK8sJob(JOB, { image: "img", hostNetwork: true }, "n", "ns") as unknown as {
      spec: { template: { spec: { hostNetwork?: boolean } } };
    };
    expect(m.spec.template.spec.hostNetwork).toBe(true);
    const off = buildK8sJob(JOB, { image: "img" }, "n", "ns") as unknown as {
      spec: { template: { spec: { hostNetwork?: boolean } } };
    };
    expect(off.spec.template.spec.hostNetwork).toBeUndefined();
  });

  it("k8sJobName 은 DNS-1123 으로 정규화한다", () => {
    expect(k8sJobName({ ...JOB, evalCase: { ...JOB.evalCase, id: "Web_Case#1" } })).toBe("assay-web-case-1");
  });
});

describe("K8sBackend.dispatch", () => {
  it("Job apply → 완료 폴링 → 파드 로그 sentinel 파싱 → 정리(delete)", async () => {
    const { api, applied, deleted } = mockApi();
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    const result = await backend.dispatch(JOB);
    expect(result.caseId).toBe("c1");
    expect(result.harness).toBe("aider@latest");
    expect(applied).toHaveLength(1);
    expect(deleted).toEqual(["assay-c1"]); // finally 정리
  });

  it("Job 실패 → UpstreamError 이지만 정리는 수행", async () => {
    const { api, deleted } = mockApi({ failed: true });
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1 });
    await expect(backend.dispatch(JOB)).rejects.toBeInstanceOf(UpstreamError);
    expect(deleted).toEqual(["assay-c1"]);
  });

  it("trustZones: 테넌트 존을 잡마다 적용(네임스페이스 + runtimeClassName=gvisor)", async () => {
    const { api, applied } = mockApi();
    const backend = new K8sBackend({ image: "img", api, pollIntervalMs: 1, trustZones: perTenantTrustZones() });
    await backend.dispatch({ ...JOB, tenant: "acme" });
    expect(applied[0]?.metadata.namespace).toBe("assay-acme");
    expect(applied[0]?.spec.template.spec.runtimeClassName).toBe("gvisor"); // runsc → gvisor 매핑
  });

  it("trustZones: untrusted 에 runc 강제면 디스패치 거부", async () => {
    const { api } = mockApi();
    const backend = new K8sBackend({
      image: "img",
      api,
      trustZones: staticTrustZones({}, { id: "weak", isolationRuntime: "runc", network: "open", trusted: false }),
    });
    await expect(backend.dispatch({ ...JOB, tenant: "x" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("secrets: 잡마다 그 테넌트 키만 주입(누출 없음)", async () => {
    const { api, applied } = mockApi();
    const backend = new K8sBackend({
      image: "img",
      api,
      pollIntervalMs: 1,
      secrets: staticSecrets({ acme: { ANTHROPIC_API_KEY: "sk-acme" }, globex: { ANTHROPIC_API_KEY: "sk-globex" } }),
    });
    await backend.dispatch({ ...JOB, tenant: "acme" });
    await backend.dispatch({ ...JOB, tenant: "globex" });
    expect(envOf(applied[0] as JobManifest, "ANTHROPIC_API_KEY")).toBe("sk-acme");
    expect(envOf(applied[1] as JobManifest, "ANTHROPIC_API_KEY")).toBe("sk-globex");
  });

  it("capacity: 라이브 프로브로 used 를 보고", async () => {
    const { api } = mockApi({ active: 5 });
    const backend = new K8sBackend({ image: "img", api, maxConcurrent: 10 });
    expect(await backend.capacity()).toEqual({ total: 10, used: 5 });
  });
});
