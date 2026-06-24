import type { RunnerStore } from "@assay/db";
import type { Authenticator } from "./principal.js";

export interface RunnerAuthOptions {
  runnerStore: RunnerStore;
}

// 셀프호스티드 러너 페어링 토큰(rnr_) 인증기 — `assay runner` 클라이언트용. 토큰 해시 → {owner, workspace, runnerId}.
// 최소권한: roles=["runner"] (워크스페이스 멤버 역할이 아님). lease/result/heartbeat 같은 러너 전용 도구만 쓴다.
// 컨트롤플레인은 via="runner" 를 활성-워크스페이스 부트스트랩에서 제외해 owner 의 멤버십 역할로 승격되지 않게 한다.
export function runnerAuthenticator(opts: RunnerAuthOptions): Authenticator {
  return {
    async authenticate(bearer) {
      if (!bearer.startsWith("rnr_")) return undefined;
      const r = await opts.runnerStore.resolveByToken(bearer);
      if (!r) return undefined;
      return { subject: r.owner, workspace: r.workspace, roles: ["runner"], via: "runner", runnerId: r.runnerId };
    },
  };
}
