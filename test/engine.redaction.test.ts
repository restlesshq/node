import { describe, it, expect, vi } from "vitest";
import { CaptureEngine } from "../src/lib/capture.js";

/**
 * End-to-end: the engine applies redaction + truncation before handing
 * to the uploader. These tests inspect the payload the uploader tries to POST.
 */
async function captureOne(captured: Parameters<CaptureEngine["record"]>[0], redact?: any) {
  let sent: any;
  const fetchImpl = vi.fn().mockImplementation(async (_url, init: any) => {
    sent = JSON.parse(init.body);
    return { ok: true, text: async () => "" };
  });
  const engine = new CaptureEngine({
    apiKey: "test",
    baseUrl: "http://localhost:3003",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    redact,
  });
  engine.record(captured);
  await new Promise((r) => setTimeout(r, 0));
  return sent[0].request.log.entries[0];
}

describe("CaptureEngine — redaction pipeline", () => {
  it("redacts Authorization in request headers", async () => {
    const entry = await captureOne({
      requestId: "id-1",
      startedAt: new Date().toISOString(),
      request: {
        method: "GET",
        url: "http://x/",
        headers: {
          authorization: "Bearer abcdef0123456789",
          "content-type": "application/json",
        },
      },
      response: { status: 200, headers: {} },
      duration: 1,
    });
    const auth = entry.request.headers.find(
      (h: any) => h.name === "authorization",
    );
    // Auth-scheme prefix is preserved; only the credential gets replaced.
    expect(auth.value).toMatch(/^Bearer <REDACTED:\d+(:.{4})?>$/);
  });

  it("redacts api_key in query string", async () => {
    const entry = await captureOne({
      requestId: "id-1",
      startedAt: new Date().toISOString(),
      request: {
        method: "GET",
        url: "http://x/foo?api_key=sk_abcdef123&bar=ok",
        headers: {},
      },
      response: { status: 200, headers: {} },
      duration: 1,
    });
    expect(entry.request.url).toMatch(/api_key=%3CREDACTED/);
    expect(entry.request.url).toMatch(/bar=ok/);
  });

  it("redacts password in JSON body", async () => {
    const entry = await captureOne({
      requestId: "id-1",
      startedAt: new Date().toISOString(),
      request: {
        method: "POST",
        url: "http://x/login",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "jane", password: "hunter2hunter2" }),
      },
      response: { status: 200, headers: {} },
      duration: 1,
    });
    const body = JSON.parse(entry.request.postData.text);
    expect(body.user).toBe("jane");
    expect(body.password).toMatch(/^<REDACTED:/);
  });

  it("honors user-supplied extra denylist", async () => {
    const entry = await captureOne(
      {
        requestId: "id-1",
        startedAt: new Date().toISOString(),
        request: {
          method: "POST",
          url: "http://x/",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mySecretField: "verylongsecret123" }),
        },
        response: { status: 200, headers: {} },
        duration: 1,
      },
      { bodyKeys: ["mySecretField"] },
    );
    const body = JSON.parse(entry.request.postData.text);
    expect(body.mySecretField).toMatch(/^<REDACTED:/);
  });

  it("truncates bodies > 256KB", async () => {
    const big = "x".repeat(300 * 1024); // 300KB
    const entry = await captureOne({
      requestId: "id-1",
      startedAt: new Date().toISOString(),
      request: {
        method: "POST",
        url: "http://x/",
        headers: { "content-type": "text/plain" },
        body: big,
      },
      response: { status: 200, headers: {} },
      duration: 1,
    });
    expect(entry.request.postData.text).toMatch(/TRUNCATED: original 307200/);
    expect(entry.request.postData.text.length).toBeLessThan(big.length);
  });
});
