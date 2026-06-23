import { AppError } from "@assay/core";
import { InMemoryUserProfileStore } from "@assay/db";
import { describe, expect, it } from "vitest";
import { ProfileService } from "./profile-service.js";

function svc(): ProfileService {
  return new ProfileService(new InMemoryUserProfileStore());
}

describe("ProfileService", () => {
  it("이름/유저네임/아바타를 설정하고 get 으로 읽는다", async () => {
    const s = svc();
    const p = await s.update("u1", { name: "Alice", username: "alice", avatarUrl: "https://x/a.png" });
    expect(p).toMatchObject({ name: "Alice", username: "alice", avatarUrl: "https://x/a.png" });
    expect((await s.get("u1"))?.name).toBe("Alice");
  });

  it("빈 문자열은 해당 필드를 삭제한다", async () => {
    const s = svc();
    await s.update("u1", { name: "Alice", avatarUrl: "https://x/a.png" });
    const p = await s.update("u1", { avatarUrl: "  " }); // 공백 → 삭제
    expect(p.name).toBe("Alice");
    expect(p.avatarUrl).toBeUndefined();
  });

  it("제공하지 않은 필드는 유지(부분 갱신)", async () => {
    const s = svc();
    await s.update("u1", { name: "Alice", username: "alice" });
    const p = await s.update("u1", { name: "Alice Kim" });
    expect(p.username).toBe("alice");
  });

  it("너무 긴 이름은 400(BAD_REQUEST)", async () => {
    const s = svc();
    await expect(s.update("u1", { name: "a".repeat(81) })).rejects.toBeInstanceOf(AppError);
  });

  it("형식이 틀린 유저네임은 거부", async () => {
    const s = svc();
    await expect(s.update("u1", { username: "no spaces!" })).rejects.toBeInstanceOf(AppError);
  });

  it("http(s) 가 아닌 아바타 URL 은 거부", async () => {
    const s = svc();
    await expect(s.update("u1", { avatarUrl: "ftp://x/a.png" })).rejects.toBeInstanceOf(AppError);
    await expect(s.update("u1", { avatarUrl: "not a url" })).rejects.toBeInstanceOf(AppError);
  });

  it("업로드한 data:image base64 아바타는 그대로 저장한다", async () => {
    const s = svc();
    const dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=="; // 짧은 JPEG 헤더 샘플
    const p = await s.update("u1", { avatarUrl: dataUrl });
    expect(p.avatarUrl).toBe(dataUrl);
  });

  it("이미지가 아닌 data URL 은 거부", async () => {
    const s = svc();
    await expect(s.update("u1", { avatarUrl: "data:text/plain;base64,aGVsbG8=" })).rejects.toBeInstanceOf(AppError);
  });

  it("너무 큰 data URL 아바타는 거부", async () => {
    const s = svc();
    const huge = `data:image/png;base64,${"A".repeat(1_400_001)}`;
    await expect(s.update("u1", { avatarUrl: huge })).rejects.toBeInstanceOf(AppError);
  });
});
