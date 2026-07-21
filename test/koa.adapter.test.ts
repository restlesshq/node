import { describe, it, expect, vi, beforeEach } from "vitest";
import restlessKoa from "../src/adapters/koa.js";
import { _resetSettingsCache } from "../src/lib/settings.js";

/**
 * Build a minimal mock Koa ctx. Enough surface for the SDK middleware to
 * read headers/body and stamp response state without pulling Koa in as a
 * test dep.
 */
function mockCtx(overrides: any = {}) {
  const resHeaders: Record<string, string> = {};
  return {
    protocol: "http",
    host: "localhost",
    originalUrl: "/upload",
    url: "/upload",
    method: "POST",
    status: 200,
    body: "ok",
    request: {
      headers: {
        host: "localhost",
        "content-type": "multipart/form-data; boundary=----x",
      },
      body: undefined,
    },
    response: { headers: resHeaders },
    set: (k: string, v: string) => {
      resHeaders[k] = v;
    },
    ...overrides,
  };
}

describe("koa adapter", () => {
  beforeEach(() => _resetSettingsCache());

  it("captures a circular multipart body without throwing (records body undefined)", async () => {
    // Regression: a multipart parser that attaches parsed fields to
    // ctx.request.body can produce circular structures (a file's `.fields`
    // back-pointer). Pre-fix, `JSON.stringify(ctx.request.body)` threw and
    // broke the request path.
    let uploaded: any;
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      uploaded = JSON.parse(init.body);
      return { ok: true, text: async () => "" } as any;
    });
    const client = restlessKoa("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const mw = client.setup(() => ({ apiKey: "k" }));

    // body.schema.fields === body.
    const file: any = { type: "file", filename: "a.png" };
    const fields: any = { schema: file };
    file.fields = fields;

    const ctx = mockCtx();
    ctx.request.body = fields;

    // The request completes normally: middleware resolves, no throw.
    await expect(mw(ctx, async () => {})).resolves.toBeUndefined();

    await client.flush();
    expect(fetchImpl).toHaveBeenCalled();
    const entry = uploaded[0].request.log.entries[0];
    // No postData recorded because the body dropped to undefined.
    expect(entry.request.postData).toBeUndefined();
  });

  it("still captures a normal JSON body", async () => {
    let uploaded: any;
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      uploaded = JSON.parse(init.body);
      return { ok: true, text: async () => "" } as any;
    });
    const client = restlessKoa("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const mw = client.setup(() => ({ apiKey: "k" }));

    const ctx = mockCtx({
      request: {
        headers: { host: "localhost", "content-type": "application/json" },
        body: { hello: "world" },
      },
    });

    await mw(ctx, async () => {});
    await client.flush();

    const entry = uploaded[0].request.log.entries[0];
    expect(entry.request.postData.text).toBe('{"hello":"world"}');
  });
});
