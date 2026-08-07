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
      project: { id: "acme", enrich: async () => ({ label: "Acme" }) },
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

  it("uploads to the baseUrl option, ahead of RESTLESS_BASE_URL", async () => {
    // Precedence matches base_url= in Python and WithBaseURL(...) in Go:
    // explicit option, then env, then the default ingest.
    const oldEnv = process.env.RESTLESS_BASE_URL;
    process.env.RESTLESS_BASE_URL = "http://localhost:4444";
    try {
      let calledUrl: string | undefined;
      const fetchImpl = vi.fn(async (url: string) => {
        calledUrl = url;
        return { ok: true, text: async () => "", json: async () => ({}) } as any;
      });
      const client = restless("rdme_test", {
        baseUrl: "http://localhost:5555",
        fetch: fetchImpl as unknown as typeof fetch,
      });
      client.engine.record({
        requestId: "r1",
        startedAt: new Date().toISOString(),
        request: { method: "GET", url: "http://x/y", headers: {} },
        response: { status: 200, headers: {} },
        duration: 1,
      });
      await client.flush();
      expect(calledUrl).toBe("http://localhost:5555/v1/request");
    } finally {
      if (oldEnv === undefined) delete process.env.RESTLESS_BASE_URL;
      else process.env.RESTLESS_BASE_URL = oldEnv;
    }
  });

  it("falls back to RESTLESS_BASE_URL when no option is given", async () => {
    const oldEnv = process.env.RESTLESS_BASE_URL;
    process.env.RESTLESS_BASE_URL = "http://localhost:4444";
    try {
      let calledUrl: string | undefined;
      const fetchImpl = vi.fn(async (url: string) => {
        calledUrl = url;
        return { ok: true, text: async () => "", json: async () => ({}) } as any;
      });
      const client = restless("rdme_test", {
        fetch: fetchImpl as unknown as typeof fetch,
      });
      client.engine.record({
        requestId: "r1",
        startedAt: new Date().toISOString(),
        request: { method: "GET", url: "http://x/y", headers: {} },
        response: { status: 200, headers: {} },
        duration: 1,
      });
      await client.flush();
      expect(calledUrl).toBe("http://localhost:4444/v1/request");
    } finally {
      if (oldEnv === undefined) delete process.env.RESTLESS_BASE_URL;
      else process.env.RESTLESS_BASE_URL = oldEnv;
    }
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
