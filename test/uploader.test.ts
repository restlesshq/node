import { describe, it, expect, vi } from "vitest";
import { Uploader } from "../src/lib/uploader.js";
import { SPEC_VERSION } from "../src/lib/version.js";
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

  it("sends X-Restless-Spec-Version on every upload", async () => {
    // CONTRACT.md META-002: the ingest attributes an off-contract payload
    // to an SDK + spec version instead of guessing at it.
    let init: any;
    const fetchImpl = vi.fn(async (_url: string, i: any) => {
      init = i;
      return { ok: true, text: async () => "" } as any;
    });
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    up.push(mkCaptured("a"));
    await up.flush();
    expect(init.headers["X-Restless-Spec-Version"]).toBe(SPEC_VERSION);
    expect(SPEC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
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

// Spec 1.3.0: bounded concurrency (BATCH-009/010), refused-upload retries
// (WIRE-026/027) and the upload timeout (WIRE-028).
describe("Uploader: cap, retries, timeout", () => {
  const ok = () => ({ ok: true, status: 202, text: async () => "", json: async () => ({}) });
  const refused = (status: number, retryAfter = "0") => ({
    ok: false,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? retryAfter : null) },
    text: async () => "busy",
  });
  const entriesIn = (call: unknown[]) =>
    (JSON.parse((call[1] as { body: string }).body) as unknown[]).length;

  async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      return await fn();
    } finally {
      if (orig === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = orig;
    }
  }

  it("never runs more than 4 uploads at once, and sends the backlog 100 at a time", () =>
    inProduction(async () => {
      const release: Array<() => void> = [];
      const fetchImpl = vi.fn(
        () => new Promise((resolve) => release.push(() => resolve(ok()))),
      );
      const up = new Uploader({
        apiKey: "k",
        baseUrl: "https://remote.example",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      for (let i = 0; i < 300; i++) up.push(mkCaptured(`r-${i}`));
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(fetchImpl.mock.calls.map(entriesIn)).toEqual([10, 10, 10, 10]);

      // Each freed slot takes up to 100 of what queued behind the cap.
      release.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchImpl.mock.calls.slice(4).map(entriesIn)).toEqual([100, 100, 60]);

      release.splice(0).forEach((r) => r());
      await up.flush();
      expect(fetchImpl.mock.calls.map(entriesIn).reduce((a, b) => a + b, 0)).toBe(300);
    }));

  it("retries 503 and 429 with the same body, honouring Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(refused(503))
      .mockResolvedValueOnce(refused(429))
      .mockResolvedValueOnce(ok());
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    up.push(mkCaptured("a"));
    await up.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const bodies = fetchImpl.mock.calls.map((c) => (c[1] as { body: string }).body);
    expect(new Set(bodies).size).toBe(1);
  });

  it("gives up on a refused upload after 2 retries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(refused(503));
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    up.push(mkCaptured("a"));
    await up.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a 502 (the ingest may have stored it)", () => Promise.resolve(refused(502))],
    ["a 504", () => Promise.resolve(refused(504))],
    [
      "a timeout",
      () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
    ],
    [
      "a reset after the request was sent",
      () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })),
    ],
  ])("does not retry %s", async (_label, respond) => {
    const fetchImpl = vi.fn(respond);
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    up.push(mkCaptured("a"));
    await up.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a connection that never reached the ingest", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
        )
        .mockResolvedValueOnce(ok());
      const up = new Uploader({
        apiKey: "k",
        baseUrl: "http://localhost:3003",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      up.push(mkCaptured("a"));
      const flushed = up.flush();
      await vi.runAllTimersAsync();
      await flushed;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives every upload a timeout signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const up = new Uploader({
      apiKey: "k",
      baseUrl: "http://localhost:3003",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    up.push(mkCaptured("a"));
    await up.flush();

    expect((fetchImpl.mock.calls[0][1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it("never surfaces a rejection when reading a failed response throws", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error("body stream broke")),
      });
      const up = new Uploader({
        apiKey: "k",
        baseUrl: "http://localhost:3003",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      up.push(mkCaptured("a"));
      await up.flush();
      await new Promise((r) => setTimeout(r, 0));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
