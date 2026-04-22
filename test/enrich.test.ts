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

describe("CaptureEngine: project.enrich flow", () => {
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
      .mockResolvedValue({ label: "Acme", email: "a@b.co" });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      project: { id: "acme-id", enrich },
    }));

    const first = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledWith("acme-id");
    expect(first.project).toMatchObject({
      id: "acme-id",
      label: "Acme",
      email: "a@b.co",
    });
    // enrich fn itself must not leak into the resolved project
    expect("enrich" in (first.project || {})).toBe(false);

    const second = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1); // cached
    // On cached hits the inline project (just id) is what ships
    expect(second.project).toEqual({ id: "acme-id" });
  });

  it("merges inline project fields with enrich() output on first-seen", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ email: "enriched@acme.co" });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      project: {
        id: "acme-id",
        label: "Acme (inline)", // inline cheap field
        enrich,
      },
    }));

    const first = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(first.project).toEqual({
      id: "acme-id",
      label: "Acme (inline)",
      email: "enriched@acme.co",
    });
  });

  it("caches by project.id so multiple apiKeys in one project share a slot", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ label: "Acme" });
    let currentApiKey = "sha512-aaa?0001";
    engine.setCallback(() => ({
      apiKey: currentApiKey,
      project: { id: "acme-id", enrich },
    }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);

    currentApiKey = "sha512-bbb?0002";
    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1); // same project, no re-run
  });

  it("re-enriches after server invalidation on project.id", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ label: "Acme" });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      project: { id: "acme-id", enrich },
    }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1);

    (engine as unknown as {
      handleServerResponse: (body: unknown) => void;
    }).handleServerResponse({ needsEnrichment: ["acme-id"] });

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(2);
  });

  it("swallows enrich() throws without breaking the request", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockRejectedValue(new Error("db down"));
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      project: { id: "acme-id", label: "Acme", enrich },
    }));

    const result = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(result.apiKey).toBe("sha512-xxx?1234");
    // Inline field survived; enrich failed silently
    expect(result.project).toEqual({ id: "acme-id", label: "Acme" });
  });

  it("skips enrich when project.id is missing", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ label: "X" });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      project: { enrich }, // no id
    }));

    await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("works with a project that has no enrich (inline-only)", async () => {
    const { engine } = mkEngine();
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      project: { id: "acme-id", label: "Acme", email: "a@b.co" },
    }));

    const result = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(result.project).toEqual({
      id: "acme-id",
      label: "Acme",
      email: "a@b.co",
    });
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

    const enrich = vi.fn().mockResolvedValue({ label: "Acme" });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      project: { id: "acme-id", enrich },
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
