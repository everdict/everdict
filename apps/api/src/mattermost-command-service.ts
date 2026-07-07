import { timingSafeEqual } from "node:crypto";
import { ForbiddenError } from "@everdict/core";
import type { WorkspaceSettingsStore } from "@everdict/db";

// Mattermost 인바운드(슬래시커맨드 + 인터랙티브 버튼) 처리 — Everdict 의 첫 인바운드 표면.
// 워크스페이스는 URL(?ws=)로 라우팅하고, 진위는 commandTokenSecretName 값과 요청 token 을 **상수시간 비교**로 검증한다(fail-closed).
// 설계: docs/architecture/workspace-scoped-integrations.md (S7/S8)

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// Mattermost 슬래시커맨드 응답 — response_type=in_channel(모두 보임)|ephemeral(호출자만).
export interface MattermostReply {
  response_type: "ephemeral" | "in_channel";
  text: string;
}

export interface MattermostCommandServiceDeps {
  settings: WorkspaceSettingsStore;
  secretsFor: (workspace: string) => Promise<Record<string, string>>;
  // 채팅에서 스코어카드 발사(선택) — 없으면 run/재실행 비활성. 반환 id 로 링크 구성.
  submitScorecard?: (
    workspace: string,
    input: { dataset: string; harness: string; submittedBy: string },
  ) => Promise<{ id: string }>;
  // 리더보드 조회(선택) — {label,value} 행으로 반환(포매팅은 이 서비스가).
  leaderboard?: (workspace: string, datasetId: string) => Promise<Array<{ label: string; value: string }>>;
  webBaseUrl?: string; // 결과 링크 베이스
}

export class MattermostCommandService {
  constructor(private readonly deps: MattermostCommandServiceDeps) {}

  // 인바운드 검증 — commandTokenSecretName 값과 상수시간 비교. 미설정/토큰없음/불일치 전부 거부(fail-closed).
  private async verify(workspace: string, token?: string): Promise<void> {
    const mm = (await this.deps.settings.get(workspace))?.mattermost;
    if (!mm?.commandTokenSecretName)
      throw new ForbiddenError(
        "FORBIDDEN",
        { workspace },
        "이 워크스페이스는 Mattermost 인바운드가 설정되지 않았습니다.",
      );
    const expected = (await this.deps.secretsFor(workspace))[mm.commandTokenSecretName];
    if (!expected || !token || !constantTimeEq(token, expected))
      throw new ForbiddenError("FORBIDDEN", { workspace }, "Mattermost 요청 토큰 검증 실패.");
  }

  // 슬래시커맨드 `/everdict <sub> …` — 검증 후 파싱·디스패치. token/text/user_name 은 MM 폼 필드.
  async handleCommand(
    workspace: string,
    input: { token?: string; text?: string; userName?: string },
  ): Promise<MattermostReply> {
    await this.verify(workspace, input.token);
    const parts = (input.text ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? "help").toLowerCase();

    if (sub === "status")
      return {
        response_type: "ephemeral",
        text: `Everdict 워크스페이스 **${workspace}** 연결됨. \`run\` · \`leaderboard\` · \`help\` 사용 가능.`,
      };

    if (sub === "run") {
      if (!this.deps.submitScorecard)
        return { response_type: "ephemeral", text: "이 배포에서는 채팅 실행이 비활성입니다." };
      const harness = parts[1];
      const dataset = parts[2];
      if (!harness || !dataset)
        return { response_type: "ephemeral", text: "사용법: `/everdict run <harness> <dataset>`" };
      const sc = await this.deps.submitScorecard(workspace, {
        dataset,
        harness,
        submittedBy: `mattermost:${input.userName ?? "user"}`,
      });
      const link = this.deps.webBaseUrl
        ? ` — ${trimSlash(this.deps.webBaseUrl)}/${encodeURIComponent(workspace)}/scorecards/${sc.id}`
        : "";
      return {
        response_type: "in_channel",
        text: `▶️ 스코어카드 실행 시작: \`${harness}\` × \`${dataset}\` (id \`${sc.id}\`)${link}`,
      };
    }

    if (sub === "leaderboard") {
      if (!this.deps.leaderboard) return { response_type: "ephemeral", text: "리더보드가 비활성입니다." };
      const dataset = parts[1];
      if (!dataset) return { response_type: "ephemeral", text: "사용법: `/everdict leaderboard <dataset>`" };
      const rows = await this.deps.leaderboard(workspace, dataset);
      if (rows.length === 0) return { response_type: "ephemeral", text: `\`${dataset}\` 리더보드가 비어 있어요.` };
      const body = rows
        .slice(0, 10)
        .map((r, i) => `${i + 1}. \`${r.label}\` — ${r.value}`)
        .join("\n");
      return { response_type: "in_channel", text: `🏆 **${dataset}** 리더보드\n${body}` };
    }

    return this.help();
  }

  private help(): MattermostReply {
    return {
      response_type: "ephemeral",
      text: [
        "**Everdict** 명령어:",
        "• `/everdict run <harness> <dataset>` — 스코어카드 실행",
        "• `/everdict leaderboard <dataset>` — 리더보드",
        "• `/everdict status` — 연결 확인",
      ].join("\n"),
    };
  }

  // 인터랙티브 버튼(액션) — context 에 실린 token 을 검증 후 지정 액션 수행(현재: 스코어카드 재실행).
  async handleAction(
    workspace: string,
    input: { token?: string; action?: string; context?: { dataset?: string; harness?: string; userName?: string } },
  ): Promise<{ ephemeral_text: string }> {
    await this.verify(workspace, input.token);
    if (input.action === "rerun" && this.deps.submitScorecard && input.context?.dataset && input.context?.harness) {
      const sc = await this.deps.submitScorecard(workspace, {
        dataset: input.context.dataset,
        harness: input.context.harness,
        submittedBy: `mattermost:${input.context.userName ?? "button"}`,
      });
      return { ephemeral_text: `▶️ 재실행 시작 (id ${sc.id})` };
    }
    return { ephemeral_text: "알 수 없는 액션이에요." };
  }
}
