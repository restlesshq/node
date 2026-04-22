import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import restless from "../src/index.js";

/**
 * Drive the universal middleware from each supported framework's call shape
 * and make sure the right adapter fires. We don't import the frameworks
 * themselves — we fake their call shapes (that's the whole point of
 * runtime detection).
 */

function mkClient() {
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ingested: 1 }),
    text: async () => "",
  });
  return restless("rdme_test", {
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

describe("universal middleware: runtime framework detection", () => {
  it("detects Express when called with (req, res, next)", async () => {
    const client = mkClient();
    const cb = vi.fn().mockReturnValue({ apiKey: "k" });
    const mw = client.setup(cb);

    // Spin up a real http.Server (Express-style) and route through mw
    const server = http.createServer((req, res) => {
      (mw as any)(req, res, () => {
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-restless-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(cb).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("detects Fastify when called with (instance) having .addHook", () => {
    const client = mkClient();
    const mw = client.setup((req) => ({ apiKey: "k" }));

    // Minimal fastify-shaped mock
    const hooks: Record<string, Function[]> = {};
    const fastify = {
      addHook: (name: string, fn: Function) => {
        hooks[name] ||= [];
        hooks[name]!.push(fn);
      },
      decorateRequest: () => {},
    };
    (mw as any)(fastify);

    expect(hooks.onRequest).toHaveLength(1);
    expect(hooks.onSend).toHaveLength(1);
  });

  it("detects Koa when called with (ctx, next) having ctx.request + ctx.response", async () => {
    const client = mkClient();
    const cb = vi.fn().mockReturnValue({ apiKey: "k" });
    const mw = client.setup(cb);

    // Minimal Koa-shaped ctx
    const headers: Record<string, string> = {};
    const ctx = {
      method: "GET",
      protocol: "http",
      host: "localhost",
      originalUrl: "/hi",
      url: "/hi",
      request: { headers: { authorization: "Bearer x" } },
      response: { headers: {} },
      status: 200,
      body: { ok: true },
      set: (k: string, v: string) => {
        headers[k] = v;
      },
    };

    await (mw as any)(ctx, async () => {
      /* next */
    });
    expect(cb).toHaveBeenCalled();
    expect(headers["x-restless-id"]).toBeDefined();
  });

  it("detects Hono when called with (c, next) having c.req.raw", async () => {
    const client = mkClient();
    const cb = vi.fn().mockReturnValue({ apiKey: "k" });
    const mw = client.setup(cb);

    const reqRaw = new Request("http://localhost/hi");
    const resRaw = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const honoHeaders: Record<string, string> = {};
    const c = {
      req: { raw: reqRaw, routePath: "/hi" },
      res: resRaw,
      header: (k: string, v: string) => {
        honoHeaders[k] = v;
      },
    };
    await (mw as any)(c, async () => {
      /* next */
    });
    expect(cb).toHaveBeenCalled();
    expect(honoHeaders["x-restless-id"]).toBeDefined();
  });

  it("detects Next.js wrap when called with a single function argument", async () => {
    const client = mkClient();
    client.setup(() => ({ apiKey: "k" }));
    const mw = client.setup(() => ({ apiKey: "k" }));

    const handler = async () => new Response('{"ok":true}');
    const wrapped = (mw as any)(handler);
    expect(typeof wrapped).toBe("function");

    const res: Response = await wrapped(
      new Request("http://localhost/hi"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-restless-id")).toBeDefined();
  });

  it("throws a helpful error on an unrecognized call shape", () => {
    const client = mkClient();
    const mw = client.setup(() => ({}));

    expect(() => (mw as any)("not-a-framework-thing")).toThrow(
      /could not detect framework/,
    );
  });

  it("still works with the explicit framework adapter", async () => {
    // Proves the handle-props-on-function design keeps the explicit path alive.
    const restlessExpress = (
      await import("../src/adapters/express.js")
    ).default;
    const client = restlessExpress("rdme_test", {
      fetch: (async () => ({
        ok: true,
        json: async () => ({}),
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    const mw = client.setup(() => ({ apiKey: "k" }));
    expect(typeof mw).toBe("function");
  });
});
