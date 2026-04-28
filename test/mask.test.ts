import { describe, it, expect } from "vitest";
import { mask } from "../src/lib/mask.js";

describe("mask()", () => {
  it("produces the sha512-<base64>?<last4> format", () => {
    const out = mask("rdme_abc123wxyz");
    expect(out).toMatch(/^sha512-[A-Za-z0-9+/=]+\?wxyz$/);
  });

  it("is deterministic for the same input", () => {
    expect(mask("abcdefgh")).toEqual(mask("abcdefgh"));
  });

  it("differs for different inputs", () => {
    expect(mask("key-one-xxxx")).not.toEqual(mask("key-two-xxxx"));
  });

  it("includes the last 4 characters verbatim", () => {
    const out = mask("this-is-a-long-key-1234");
    expect(out.endsWith("?1234")).toBe(true);
  });

  it("returns undefined on falsy input (never hashes '' or undefined)", () => {
    expect(mask("")).toBeUndefined();
    expect(mask(undefined)).toBeUndefined();
    expect(mask(null)).toBeUndefined();
  });

  it("treats setup-time placeholder strings as no key", () => {
    // Anyone running our example curl without replacing the placeholder
    // shouldn't land in the masked-key list. The CLI's curl ships
    // `Bearer API_KEY_HERE` by default; the others are common in
    // copy-pasted docs.
    expect(mask("API_KEY_HERE")).toBeUndefined();
    expect(mask("YOUR_API_KEY")).toBeUndefined();
    expect(mask("YOUR_KEY")).toBeUndefined();
    expect(mask("REPLACE_ME")).toBeUndefined();
  });

  it("is idempotent — mask(mask(x)) === mask(x)", () => {
    const once = mask("rdme_abc123wxyz");
    expect(once).toBeDefined();
    expect(mask(once)).toBe(once);
  });
});
