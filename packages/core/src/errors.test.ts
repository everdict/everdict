import { describe, expect, it } from "vitest";
import { BadRequestError, NotFoundError } from "./errors.js";

describe("AppError", () => {
  it("서브타입에서 HTTP 상태가 파생된다", () => {
    expect(new BadRequestError("BAD_REQUEST").status).toBe(400);
    expect(new NotFoundError("NOT_FOUND").status).toBe(404);
  });

  it("flat 봉투 {code,message,data}를 만든다", () => {
    const err = new NotFoundError("NOT_FOUND", { id: "abc" });
    expect(err.toEnvelope()).toEqual({
      code: "NOT_FOUND",
      message: "대상을 찾을 수 없습니다.",
      data: { id: "abc" },
    });
  });
});
