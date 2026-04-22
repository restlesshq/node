import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "node:http";
import restlessExpress from "../src/adapters/express.js";
import { _resetSettingsCache } from "../src/lib/settings.js";

/**
 * Drive the Express middleware with a bare http.Server — avoids pulling
 * Express in as a test dep, while still exercising (req, res, next).
 */
async function run(
  middleware: any,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  request: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const server = http.createServer((req, res) => {
    middleware(req, res, () => handler(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    const body = await res.text();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body,
    };
  } finally {
    server.close();
  }
}

describe("express adapter (one-liner)", () => {
  beforeEach(() => _resetSettingsCache());
  it("returns a client whose setup() gives middleware directly", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => "" });
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const cb = vi.fn().mockReturnValue({
      project: { id: "acme", name: "Acme Inc" },
    });
    const mw = restless.setup(cb);

    const result = await run(
      mw,
      (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end('{"hello":"world"}');
      },
      { method: "GET", path: "/hi" },
    );
    expect(result.status).toBe(200);
    expect(cb).toHaveBeenCalled();
    await restless.flush();
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("always emits x-restless-id", async () => {
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: (async () => ({
        ok: true,
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    const mw = restless.setup(() => ({}));

    const result = await run(
      mw,
      (_req, res) => res.end("ok"),
      { method: "GET", path: "/" },
    );
    expect(result.headers["x-restless-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.headers["x-request-id"]).toBeDefined();
  });

  it("does NOT stomp incoming x-request-id — uses x-restless-id instead", async () => {
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: (async () => ({
        ok: true,
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    const mw = restless.setup(() => ({}));

    const result = await run(
      mw,
      (_req, res) => res.end("ok"),
      {
        method: "GET",
        path: "/",
        headers: { "x-request-id": "upstream-id-123" },
      },
    );
    // Our ID is on x-restless-id (always)
    expect(result.headers["x-restless-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // x-request-id should NOT be set by us (we didn't touch the upstream chain)
    expect(result.headers["x-request-id"]).toBeUndefined();
  });

  it("blocks when setup returns block config", async () => {
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: (async () => ({
        ok: true,
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    const mw = restless.setup(() => ({
      block: { status: 429, message: "slow down" },
    }));

    const result = await run(
      mw,
      (_req, res) => res.end("SHOULD NOT REACH"),
      { method: "GET", path: "/" },
    );
    expect(result.status).toBe(429);
    expect(JSON.parse(result.body)).toEqual({ error: "slow down" });
  });

  it("injects debug info on 4xx JSON responses", async () => {
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: (async () => ({
        ok: true,
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    const mw = restless.setup(() => ({}));

    const result = await run(
      mw,
      (_req, res) => {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end('{"error":"not found"}');
      },
      { method: "GET", path: "/missing" },
    );
    expect(result.status).toBe(404);
    expect(result.headers["x-log-url"]).toMatch(/\/logs\//);
    expect(result.headers["x-debug"]).toMatch(/npx api debug/);
    const parsed = JSON.parse(result.body);
    expect(parsed.debug).toBeDefined();
    expect(parsed.debug.log).toMatch(/\/logs\//);
    expect(parsed.debug.cli).toMatch(/npx api debug/);
    expect(parsed.error).toBe("not found");
  });

  it("does NOT touch 2xx responses", async () => {
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: (async () => ({
        ok: true,
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    const mw = restless.setup(() => ({}));

    const result = await run(
      mw,
      (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end('{"hello":"world"}');
      },
      { method: "GET", path: "/" },
    );
    expect(result.status).toBe(200);
    expect(result.headers["x-log-url"]).toBeUndefined();
    expect(JSON.parse(result.body)).toEqual({ hello: "world" });
  });

  it("exposes the one-liner surface", () => {
    const restless = restlessExpress("rdme_test");
    expect(typeof restless.setup).toBe("function");
    expect(typeof restless.mask).toBe("function");
    expect(typeof restless.flush).toBe("function");
  });
});
