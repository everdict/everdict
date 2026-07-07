import { describe, expect, it } from "vitest";
import { BadRequestError, NotFoundError } from "./errors.js";

describe("AppError", () => {
  it("derives the HTTP status from the subtype", () => {
    expect(new BadRequestError("BAD_REQUEST").status).toBe(400);
    expect(new NotFoundError("NOT_FOUND").status).toBe(404);
  });

  it("builds a flat envelope {code,message,data}", () => {
    const err = new NotFoundError("NOT_FOUND", { id: "abc" });
    expect(err.toEnvelope()).toEqual({
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
      data: { id: "abc" },
    });
  });
});
