import { describe, it, expect, vi, beforeEach } from "vitest";
import restless from "../src/index.js";
import { _resetSettingsCache } from "../src/lib/settings.js";

describe("restless() factory + setup()", () => {
  beforeEach(() => _resetSettingsCache());

  it("returns a client with mask + setup + flush", () => {
    const client = restless("rdme_test");
    expect(typeof client.mask).toBe("function");
    expect(typeof client.setup).toBe("function");
    expect(typeof client.flush).toBe("function");
  });

  it("mask() returns the masked form", () => {
    const client = restless("rdme_test");
    const m = client.mask("some-user-api-key-abcd");
    expect(m).toMatch(/^sha512-[A-Za-z0-9+/=]+\?abcd$/);
  });

  it("setup() stores the callback and returns a polymorphic function with handle props", () => {
    const client = restless("rdme_test");
    const cb = vi.fn().mockReturnValue({
      apiKey: "masked",
      project: { id: "acme" },
    });
    const mw = client.setup(cb);
    // setup() returns a function now, with handle props attached
    expect(typeof mw).toBe("function");
    expect((mw as any).__restless).toBe(client);
    expect((mw as any).__cb).toBe(cb);
  });

  it("engine.resolve() calls the setup callback", async () => {
    const client = restless("rdme_test");
    const cb = vi.fn().mockResolvedValue({
      apiKey: "masked",
      project: { id: "acme", label: "Acme" },
    });
    client.setup(cb);
    const result = await client.engine.resolve({
      method: "POST",
      url: "http://x/y",
      headers: { authorization: "Bearer t" },
    });
    expect(cb).toHaveBeenCalledWith({
      method: "POST",
      url: "http://x/y",
      headers: { authorization: "Bearer t" },
    });
    expect(result.apiKey).toBe("masked");
    expect(result.project).toEqual({ id: "acme", label: "Acme" });
  });

  it("swallows setup-callback errors", async () => {
    const client = restless("rdme_test");
    client.setup(() => {
      throw new Error("boom");
    });
    const result = await client.engine.resolve({
      method: "GET",
      url: "/",
      headers: {},
    });
    expect(result).toEqual({});
  });

  it("falls back to RESTLESS_KEY env var", () => {
    const oldEnv = process.env.RESTLESS_KEY;
    process.env.RESTLESS_KEY = "env-key";
    try {
      const client = restless();
      expect(client).toBeDefined();
    } finally {
      if (oldEnv === undefined) delete process.env.RESTLESS_KEY;
      else process.env.RESTLESS_KEY = oldEnv;
    }
  });
});
