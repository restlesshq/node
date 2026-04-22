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

describe("CaptureEngine: enrichment flow", () => {
  function mkEngine() {
    const fetchImpl = vi.fn().mockResolvedValue({
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

  it("calls enrich() on the first-seen project and caches it", async () => {
    const { engine } = mkEngine();
    const enrich = vi
      .fn()
      .mockResolvedValue({ project: { label: "Acme", emails: ["a@b.co"] } });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      projectId: "acme-id",
      enrich,
    }));

    const first = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(first.projectId).toBe("acme-id");
    expect(first._enriched).toEqual({
      project: { label: "Acme", emails: ["a@b.co"] },
    });
    // enrich fn itself should not leak onto the result
    expect("enrich" in first).toBe(false);

    const second = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1); // cached
    expect(second._enriched).toBeUndefined();
  });

  it("caches by projectId so multiple apiKeys in one project share a slot", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ project: { label: "Acme" } });
    let currentApiKey = "sha512-aaa?0001";
    engine.setCallback(() => ({
      apiKey: currentApiKey,
      projectId: "acme-id",
      enrich,
    }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);

    // Different user inside the same project — should hit cache
    currentApiKey = "sha512-bbb?0002";
    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it("re-enriches after server invalidation on projectId", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ project: { label: "Acme" } });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      projectId: "acme-id",
      enrich,
    }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);

    (
      engine as unknown as {
        handleServerResponse: (body: unknown) => void;
      }
    ).handleServerResponse({ needsEnrichment: ["acme-id"] });

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(2);
  });

  it("swallows enrich() throws without breaking the request", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockRejectedValue(new Error("db down"));
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      projectId: "acme-id",
      enrich,
    }));

    const result = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(result.apiKey).toBe("sha512-xxx?1234");
    expect(result._enriched).toBeUndefined();
  });

  it("falls back to caching by apiKey when no projectId", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ project: { label: "Solo" } });
    engine.setCallback(() => ({ apiKey: "sha512-xxx?1234", enrich }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it("skips enrich when neither projectId nor apiKey is set", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ project: { label: "Nope" } });
    engine.setCallback(() => ({ enrich }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("invalidates via the uploader response end-to-end", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ingested: 1,
        needsEnrichment: ["acme-id"],
      }),
      text: async () => "",
    });
    const engine = new CaptureEngine({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const enrich = vi.fn().mockResolvedValue({ project: { label: "Acme" } });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      projectId: "acme-id",
      enrich,
    }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);

    engine.record({
      requestId: "r1",
      startedAt: new Date().toISOString(),
      request: { method: "GET", url: "http://x/", headers: {} },
      response: { status: 200, headers: {} },
      duration: 1,
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(2);
  });
});
