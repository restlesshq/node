import { describe, it, expect } from "vitest";
import { Blocklist } from "../src/lib/blocklist.js";

describe("Blocklist", () => {
  it("is empty by default", () => {
    const b = new Blocklist();
    expect(b.size()).toBe(0);
    expect(b.has("anything")).toBe(false);
  });

  it("replaces the snapshot atomically", () => {
    const b = new Blocklist();
    b.replace(["a", "b"]);
    expect(b.size()).toBe(2);
    expect(b.has("a")).toBe(true);
    b.replace(["c"]);
    expect(b.has("a")).toBe(false);
    expect(b.has("c")).toBe(true);
  });

  it("returns false for undefined lookups", () => {
    const b = new Blocklist();
    b.replace(["a"]);
    expect(b.has(undefined)).toBe(false);
  });
});
