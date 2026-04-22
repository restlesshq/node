import { describe, it, expect, vi } from "vitest";
import { EnrichCache } from "../src/lib/enrichCache.js";
import { CaptureEngine } from "../src/lib/capture.js";

describe("EnrichCache", () => {
  it("starts empty", () => {
    const c = new EnrichCache();
    expect(c.isFresh("anything")).toBe(false);
    expect(c.size()).toBe(0);
  });

  it("markFresh + isFresh round-trip", () => {
    const c = new EnrichCache();
    c.markFresh("key1");
    expect(c.isFresh("key1")).toBe(true);
    expect(c.isFresh("key2")).toBe(false);
  });

  it("invalidate clears a single key", () => {
    const c = new EnrichCache();
    c.markFresh("a");
    c.markFresh("b");
    c.invalidate("a");
    expect(c.isFresh("a")).toBe(false);
    expect(c.isFresh("b")).toBe(true);
  });

  it("expires entries older than TTL", () => {
    const c = new EnrichCache(100);
    c.markFresh("key1");
    expect(c.isFresh("key1")).toBe(true);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(101);
      expect(c.isFresh("key1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CaptureEngine — enrichment flow", () => {
  function mkEngine() {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ingested: 1 }),
        text: async () => "",
      });
    const engine = new CaptureEngine({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { engine, fetchImpl };
  }

  it("calls enrich() on the first-seen user and caches it", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ email: "a@b.co" });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      enrich,
    }));

    const first = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ apiKey: "sha512-xxx?1234", email: "a@b.co" });
    // enrich itself should not leak into the result
    expect("enrich" in first).toBe(false);

    const second = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1); // cached
    expect(second.email).toBeUndefined(); // no fresh enrichment on cached requests
  });

  it("re-enriches after server invalidation", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ email: "a@b.co" });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      enrich,
    }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);

    // Server invalidates via the onResponse channel
    (engine as unknown as {
      handleServerResponse: (body: unknown) => void;
    }).handleServerResponse({
      needsEnrichment: ["sha512-xxx?1234"],
    });

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(2); // re-run after invalidation
  });

  it("swallows enrich() throws without breaking the request", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockRejectedValue(new Error("db down"));
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      enrich,
    }));

    const result = await engine.resolve({
      method: "GET",
      url: "/",
      headers: {},
    });
    expect(result.apiKey).toBe("sha512-xxx?1234");
    expect(result.email).toBeUndefined();
  });

  it("skips enrich when apiKey is missing (nothing to cache under)", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ email: "x@y.co" });
    engine.setCallback(() => ({ enrich })); // no apiKey

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("invalidates via the uploader response end-to-end", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ingested: 1,
        needsEnrichment: ["sha512-xxx?1234"],
      }),
      text: async () => "",
    });
    const engine = new CaptureEngine({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const enrich = vi.fn().mockResolvedValue({ email: "a@b.co" });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      enrich,
    }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);

    // Trigger an upload — the mocked fetch returns needsEnrichment
    engine.record({
      requestId: "r1",
      startedAt: new Date().toISOString(),
      request: { method: "GET", url: "http://x/", headers: {} },
      response: { status: 200, headers: {} },
      duration: 1,
    });
    await new Promise((r) => setTimeout(r, 0));
    // microtask chain: fetch.then → onResponse → invalidate
    await new Promise((r) => setTimeout(r, 0));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(2);
  });
});
