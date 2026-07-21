import { describe, it, expect, vi } from "vitest";
import { EnrichCache } from "../src/lib/enrichCache.js";
import { CaptureEngine } from "../src/lib/capture.js";

describe("EnrichCache", () => {
  it("starts empty", () => {
    const c = new EnrichCache();
    expect(c.get("anything")).toBe(null);
    expect(c.size()).toBe(0);
  });

  it("set + get round-trip", () => {
    const c = new EnrichCache();
    c.set("key1", { label: "Acme" });
    expect(c.get("key1")).toEqual({ label: "Acme" });
    expect(c.get("key2")).toBe(null);
  });

  it("invalidate clears a single key", () => {
    const c = new EnrichCache();
    c.set("a", { label: "A" });
    c.set("b", { label: "B" });
    c.invalidate("a");
    expect(c.get("a")).toBe(null);
    expect(c.get("b")).toEqual({ label: "B" });
  });

  it("expires entries older than TTL", () => {
    const c = new EnrichCache(100);
    c.set("key1", { label: "x" });
    expect(c.get("key1")).toEqual({ label: "x" });
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(101);
      expect(c.get("key1")).toBe(null);
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
    expect(enrich).toHaveBeenCalledTimes(1); // cached — no enrich() call
    // ...but the cached enriched values still ship every time so the
    // metrics server doesn't have to backfill from a previous request.
    expect(second.project).toEqual({
      id: "acme-id",
      label: "Acme",
      email: "a@b.co",
    });
  });

  it("ignores stray inline owner fields — enrich is the only metadata source", async () => {
    const { engine } = mkEngine();
    const enrich = vi.fn().mockResolvedValue({ email: "enriched@acme.co" });
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      // `label` here mimics an old JS caller still passing an inline field.
      // It must be dropped: enrich is the sole channel for owner metadata,
      // so only `id` plus enrich's output survive on the resolved owner.
      project: { id: "acme-id", label: "Acme (inline)", enrich } as any,
    }));

    const first = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(first.project).toEqual({
      id: "acme-id",
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
    const second = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(enrich).toHaveBeenCalledTimes(1); // same project, no re-run
    expect(second.project).toEqual({ id: "acme-id", label: "Acme" });
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
      project: { id: "acme-id", enrich },
    }));

    const result = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(result.apiKey).toBe("sha512-xxx?1234");
    // enrich failed silently; the owner still ships with its id so the
    // request path is never broken.
    expect(result.project).toEqual({ id: "acme-id" });
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

  it("ships just the id when there's no enrich (defensive: old JS caller)", async () => {
    const { engine } = mkEngine();
    engine.setCallback(() => ({
      apiKey: "sha512-xxx?1234",
      // No enrich. The type requires it, but an old JS caller might omit it;
      // resolve() must stay defensive and ship the id alone rather than throw.
      project: { id: "acme-id" } as any,
    }));

    const result = await engine.resolve({ method: "GET", url: "/", headers: {} });
    expect(result.project).toEqual({ id: "acme-id" });
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
