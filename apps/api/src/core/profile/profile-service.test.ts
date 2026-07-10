import { ProfileService } from "@everdict/application-control";
import { AppError } from "@everdict/contracts";
import { InMemoryUserProfileStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

function svc(): ProfileService {
  return new ProfileService(new InMemoryUserProfileStore());
}

describe("ProfileService", () => {
  it("sets name/username/avatar and reads them via get", async () => {
    const s = svc();
    const p = await s.update("u1", { name: "Alice", username: "alice", avatarUrl: "https://x/a.png" });
    expect(p).toMatchObject({ name: "Alice", username: "alice", avatarUrl: "https://x/a.png" });
    expect((await s.get("u1"))?.name).toBe("Alice");
  });

  it("an empty string deletes that field", async () => {
    const s = svc();
    await s.update("u1", { name: "Alice", avatarUrl: "https://x/a.png" });
    const p = await s.update("u1", { avatarUrl: "  " }); // whitespace → delete
    expect(p.name).toBe("Alice");
    expect(p.avatarUrl).toBeUndefined();
  });

  it("unspecified fields are kept (partial update)", async () => {
    const s = svc();
    await s.update("u1", { name: "Alice", username: "alice" });
    const p = await s.update("u1", { name: "Alice Kim" });
    expect(p.username).toBe("alice");
  });

  it("a too-long name → 400 (BAD_REQUEST)", async () => {
    const s = svc();
    await expect(s.update("u1", { name: "a".repeat(81) })).rejects.toBeInstanceOf(AppError);
  });

  it("an invalid username is rejected", async () => {
    const s = svc();
    await expect(s.update("u1", { username: "no spaces!" })).rejects.toBeInstanceOf(AppError);
  });

  it("a non-http(s) avatar URL is rejected", async () => {
    const s = svc();
    await expect(s.update("u1", { avatarUrl: "ftp://x/a.png" })).rejects.toBeInstanceOf(AppError);
    await expect(s.update("u1", { avatarUrl: "not a url" })).rejects.toBeInstanceOf(AppError);
  });

  it("an uploaded data:image base64 avatar is stored as-is", async () => {
    const s = svc();
    const dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=="; // short JPEG header sample
    const p = await s.update("u1", { avatarUrl: dataUrl });
    expect(p.avatarUrl).toBe(dataUrl);
  });

  it("a non-image data URL is rejected", async () => {
    const s = svc();
    await expect(s.update("u1", { avatarUrl: "data:text/plain;base64,aGVsbG8=" })).rejects.toBeInstanceOf(AppError);
  });

  it("a too-large data URL avatar is rejected", async () => {
    const s = svc();
    const huge = `data:image/png;base64,${"A".repeat(1_400_001)}`;
    await expect(s.update("u1", { avatarUrl: huge })).rejects.toBeInstanceOf(AppError);
  });
});
