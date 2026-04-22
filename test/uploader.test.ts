import { describe, it, expect, vi } from "vitest";
import { Uploader } from "../src/lib/uploader.js";
import type { CapturedRequest } from "../src/types.js";

function mkCaptured(id: string): CapturedRequest {
  return {
    requestId: id,
    startedAt: new Date().toISOString(),
    request: { method: "GET", url: "http://localhost/test", headers: {} },
    response: { status: 200, headers: {} },
    duration: 1,
  };
}

describe("Uploader", () => {
  it("flushes when the queue reaches 10 (prod-mode batching)", async () => {
    // Simulate production env: NODE_ENV=production for real batching.
    // Keep SETUP_MODE=1 so uploads aren't no-op'd by the test-runner gate.
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: true, text: async () => "" });
      const up = new Uploader({
        apiKey: "test-key",
        baseUrl: "https://remote.example",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      for (let i = 0; i < 9; i++) up.push(mkCaptured(`a-${i}`));
      expect(fetchImpl).not.toHaveBeenCalled();
      up.push(mkCaptured("final"));
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (origEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origEnv;
    }
  });

  it("flushes immediately on localhost", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => "" });
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    up.push(mkCaptured("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("drops the batch when apiKey is missing", async () => {
    const fetchImpl = vi.fn();
    const up = new Uploader({
      apiKey: "",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    up.push(mkCaptured("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("emits apiKey + project (with id) in the payload", async () => {
    let sentBody: string | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: any) => {
      sentBody = init.body;
      return { ok: true, text: async () => "" };
    });
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const cap = mkCaptured("id-123");
    cap.user = {
      apiKey: "sha512-xxx?1234",
      project: {
        id: "acme-org-id",
        label: "Acme Inc",
        email: ["ops@acme.com", "ceo@acme.com"],
      },
    };
    up.push(cap);
    await new Promise((r) => setTimeout(r, 0));
    const parsed = JSON.parse(sentBody!);
    expect(parsed[0]._id).toBe("id-123");
    expect(parsed[0].apiKey).toBe("sha512-xxx?1234");
    expect(parsed[0].projectId).toBe("acme-org-id");
    expect(parsed[0].group.id).toBe("acme-org-id");
    expect(parsed[0].group.label).toBe("Acme Inc");
    expect(parsed[0].group.emails).toEqual(["ops@acme.com", "ceo@acme.com"]);
  });

  it("normalizes a single email string to an array on the wire", async () => {
    let sentBody: string | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: any) => {
      sentBody = init.body;
      return { ok: true, text: async () => "" };
    });
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const cap = mkCaptured("id-solo");
    cap.user = {
      apiKey: "sha512-xxx?1234",
      project: { id: "solo-id", label: "Solo", email: "owner@solo.dev" },
    };
    up.push(cap);
    await new Promise((r) => setTimeout(r, 0));
    const parsed = JSON.parse(sentBody!);
    expect(parsed[0].group.emails).toEqual(["owner@solo.dev"]);
  });

  it("falls back to apiKey as the group id when projectId is absent", async () => {
    let sentBody: string | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: any) => {
      sentBody = init.body;
      return { ok: true, text: async () => "" };
    });
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const cap = mkCaptured("id-456");
    cap.user = { apiKey: "sha512-xxx?1234" };
    up.push(cap);
    await new Promise((r) => setTimeout(r, 0));
    const parsed = JSON.parse(sentBody!);
    // With no project, the grouping key falls back to the masked apiKey
    expect(parsed[0].group.id).toBe("sha512-xxx?1234");
    expect(parsed[0].projectId).toBeUndefined();
  });

  it("caps the queue at MAX_QUEUE (drops oldest)", () => {
    // Stub out flush — otherwise it drains the queue synchronously at every
    // batch-size threshold. We only want to exercise the push() cap logic.
    const flushSpy = vi
      .spyOn(Uploader.prototype, "flush")
      .mockResolvedValue(undefined);
    try {
      const up = new Uploader({
        apiKey: "k",
        baseUrl: "https://remote.example",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      });
      for (let i = 0; i < 1050; i++) up.push(mkCaptured(`a-${i}`));
      const queue = (up as unknown as { queue: Array<{ requestId: string }> })
        .queue;
      expect(queue.length).toBe(1000);
      expect(queue[0]?.requestId).toBe("a-50");
      expect(queue[999]?.requestId).toBe("a-1049");
    } finally {
      flushSpy.mockRestore();
    }
  });

  it("warns on plain-http non-localhost baseUrl", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new Uploader({
      apiKey: "k",
      baseUrl: "http://api.example.com",
      fetchImpl: (async () => ({
        ok: true,
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toMatch(/plain HTTP/);
    spy.mockRestore();
  });

  it("does NOT warn on localhost http", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: (async () => ({
        ok: true,
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("is a no-op when a test runner is detected (without SETUP_MODE)", async () => {
    // Global test-setup sets RESTLESS_SETUP_MODE=1 to re-enable uploads for
    // our suite. Unset it here to exercise the no-op path.
    const origSetup = process.env.RESTLESS_SETUP_MODE;
    delete process.env.RESTLESS_SETUP_MODE;
    try {
      const fetchImpl = vi.fn();
      const up = new Uploader({
        apiKey: "k",
        baseUrl: "http://localhost:3003",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      for (let i = 0; i < 50; i++) up.push(mkCaptured(`a-${i}`));
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchImpl).not.toHaveBeenCalled();
      // Queue itself is untouched — push() returned early before queueing
      expect(
        (up as unknown as { queue: unknown[] }).queue.length,
      ).toBe(0);
    } finally {
      if (origSetup === undefined) delete process.env.RESTLESS_SETUP_MODE;
      else process.env.RESTLESS_SETUP_MODE = origSetup;
    }
  });

  it("RESTLESS_SETUP_MODE=1 forces upload even in test mode", async () => {
    // The global setup already sets SETUP_MODE=1 for the whole suite,
    // so this just verifies the expected effect.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => "" });
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "https://remote.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    up.push(mkCaptured("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("swallows fetch errors", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    up.push(mkCaptured("a"));
    await up.flush(); // must not throw
    expect(fetchImpl).toHaveBeenCalled();
  });
});
