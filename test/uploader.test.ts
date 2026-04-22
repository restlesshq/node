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
  it("flushes when the queue reaches 10", async () => {
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

  it("emits group + project in the payload", async () => {
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
      project: { id: "acme-id", name: "Acme Inc" },
    };
    up.push(cap);
    await new Promise((r) => setTimeout(r, 0));
    const parsed = JSON.parse(sentBody!);
    expect(parsed[0]._id).toBe("id-123");
    expect(parsed[0].group.id).toBe("sha512-xxx?1234");
    expect(parsed[0].group.label).toBe("Acme Inc");
    expect(parsed[0].project).toEqual({ id: "acme-id", name: "Acme Inc" });
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
