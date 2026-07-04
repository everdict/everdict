import { describe, expect, it } from "vitest";
import {
  CAPABILITY_DEFS,
  CapabilityNameSchema,
  capabilitiesOfKind,
  capabilityKind,
  functionalGate,
  partitionCapabilities,
} from "./capability.js";

describe("capability 어휘 — kind 로 분리(functional/security/auth)", () => {
  it("각 capability 가 정확한 kind 를 가진다", () => {
    expect(capabilityKind("docker")).toBe("functional");
    expect(capabilityKind("git")).toBe("functional");
    expect(capabilityKind("sandbox")).toBe("security");
    expect(capabilityKind("codex-login")).toBe("auth");
  });

  it("어휘 밖 문자열은 reject 한다(임의 라벨 금지)", () => {
    expect(CapabilityNameSchema.safeParse("docker").success).toBe(true);
    expect(CapabilityNameSchema.safeParse("repo").success).toBe(false); // 옛 이름 — 이제 git
    expect(CapabilityNameSchema.safeParse("gpu").success).toBe(false);
  });

  it("kind 별 capability 목록을 준다", () => {
    expect(capabilitiesOfKind("security")).toEqual(["sandbox"]);
    expect(capabilitiesOfKind("auth").sort()).toEqual(["claude-login", "codex-login"]);
    expect(capabilitiesOfKind("functional")).toContain("docker");
  });

  it("요구 capability 를 kind 로 분할한다(각 강제 레이어 라우팅의 진입점)", () => {
    const p = partitionCapabilities(["docker", "sandbox", "codex-login", "git"]);
    expect(p.functional.sort()).toEqual(["docker", "git"]);
    expect(p.security).toEqual(["sandbox"]);
    expect(p.auth).toEqual(["codex-login"]);
  });

  it("functionalGate 는 functional 요구만 ⊆ 로 본다(security/auth 는 placement 가 아님)", () => {
    // docker 있고 git 있음 → functional 통과
    expect(functionalGate(["docker", "git"], ["docker", "git", "browser"])).toBe(true);
    // git 없음 → functional 미충족
    expect(functionalGate(["docker", "git"], ["docker"])).toBe(false);
    // sandbox(security)/codex-login(auth) 는 게이트에서 무시 — 보유 안 해도 functional 만 맞으면 통과
    expect(functionalGate(["docker", "sandbox", "codex-login"], ["docker"])).toBe(true);
  });

  it("모든 어휘 항목의 kind 는 유효 enum 값이다", () => {
    for (const def of Object.values(CAPABILITY_DEFS)) {
      expect(["functional", "security", "auth"]).toContain(def.kind);
    }
  });
});
