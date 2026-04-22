import { describe, it, expect } from "vitest";
import {
  newRequestId,
  formatRequestId,
  stripRequestIdPrefix,
  isValidRequestId,
} from "../src/lib/requestId.js";

describe("requestId", () => {
  it("generates UUIDs", () => {
    const id = newRequestId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("generates unique IDs", () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(newRequestId());
    expect(seen.size).toBe(1000);
  });

  it("is not time-based (v4, random)", () => {
    // v4 UUIDs have the "4" in the version nibble
    const id = newRequestId();
    expect(id[14]).toBe("4");
  });

  it("round-trips a prefix", () => {
    const raw = newRequestId();
    const formatted = formatRequestId(raw, "TST");
    expect(formatted).toBe(`TST-${raw}`);
    expect(stripRequestIdPrefix(formatted)).toBe(raw);
  });

  it("leaves prefix-less IDs alone", () => {
    const raw = newRequestId();
    expect(stripRequestIdPrefix(raw)).toBe(raw);
  });

  it("validates", () => {
    expect(isValidRequestId(newRequestId())).toBe(true);
    expect(isValidRequestId("nope")).toBe(false);
  });
});
