import { UpstreamError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { endpointUnreachableError } from "./reachability.js";

describe("endpointUnreachableError", () => {
  it("is an UpstreamError that names the url and frames a cross-runtime reachability failure", () => {
    const err = endpointUnreachableError("http://127.0.0.1:32001");
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toContain("http://127.0.0.1:32001");
    expect(err.message).toContain("cannot reach it on this runtime");
  });
});
