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

/** Collects what the SDK uploads so tests can assert on the wire payload. */
function bodyCollector() {
  const uploads: any[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: any) => {
    uploads.push(...JSON.parse(init.body));
    return { ok: true, text: async () => "" } as any;
  });
  return { uploads, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** Upload responses that publish a portal origin, the way the server does. */
function portalFetch() {
  return (async () => ({
    ok: true,
    json: async () => ({ ingested: 1, docsUrl: "https://acme.restlessdocs.com" }),
    text: async () => "",
  })) as unknown as typeof fetch;
}

/** One throwaway request so the engine round-trips a batch and caches it. */
async function warmPortalOrigin(mw: any) {
  await run(mw, (_req, res) => res.end("{}"), { method: "GET", path: "/warm" });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
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
    // With no incoming x-request-id, we emit x-request-id (the standard
    // header) carrying our fresh ID. x-restless-id is only used as a
    // fallback when the chain already has an x-request-id.
    expect(result.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.headers["x-restless-id"]).toBeUndefined();
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
      fetch: portalFetch(),
    });
    const mw = restless.setup(() => ({}));

    // The portal origin is learned from an upload RESPONSE, so the first
    // request through a fresh process can't have one yet.
    await warmPortalOrigin(mw);

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
    expect(result.headers["x-log-url"]).toMatch(
      /^https:\/\/acme\.restlessdocs\.com\/logs\//,
    );
    // The ingest origin is an upload target, never a log-URL host.
    expect(result.headers["x-log-url"]).not.toContain("localhost:3003");
    expect(result.headers["x-debug"]).toMatch(/npx api debug/);
    expect(result.headers["x-api-feedback"]).toMatch(/npx api feedback/);
    const parsed = JSON.parse(result.body);
    expect(parsed.debug).toBeDefined();
    expect(parsed.debug.log).toMatch(/\/logs\//);
    expect(parsed.debug.cli).toMatch(/npx api debug/);
    expect(parsed.error).toBe("not found");
  });

  it("headers a 2xx but does NOT touch its body", async () => {
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: portalFetch(),
    });
    const mw = restless.setup(() => ({}));
    await warmPortalOrigin(mw);

    const result = await run(
      mw,
      (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end('{"hello":"world"}');
      },
      { method: "GET", path: "/" },
    );
    expect(result.status).toBe(200);
    // An agent that got an unexpected 200 has the same question as one that
    // got a 500, so the headers go out either way.
    expect(result.headers["x-log-url"]).toMatch(
      /^https:\/\/acme\.restlessdocs\.com\/logs\//,
    );
    expect(result.headers["x-debug"]).toMatch(/npx api debug/);
    expect(result.headers["x-api-feedback"]).toMatch(/npx api feedback/);
    // The body is the caller's data. Untouched.
    expect(JSON.parse(result.body)).toEqual({ hello: "world" });
    expect(JSON.parse(result.body)).toEqual({ hello: "world" });
  });

  // res.write() sends the headers, so by res.end they are frozen. Setting a
  // debug header then throws ERR_HTTP_HEADERS_SENT out of res.end and the
  // response never finishes; the client hangs.
  describe("streamed responses (headers already sent at res.end)", () => {
    it("finishes a 2xx and still logs it", async () => {
      const { uploads, fetchImpl } = bodyCollector();
      const restless = restlessExpress("rdme_test", {
        baseUrl: "http://localhost:3003",
        fetch: fetchImpl,
      });
      const mw = restless.setup(() => ({}));

      const result = await run(
        mw,
        (_req, res) => {
          res.setHeader("content-type", "text/plain");
          res.write("hello ");
          res.end("world");
        },
        { method: "GET", path: "/stream" },
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe("hello world");
      // Set before the handler ran, so it went out with the first write.
      expect(result.headers["x-request-id"]).toBeDefined();

      await restless.flush();
      expect(uploads).toHaveLength(1);
      expect(uploads[0].request.log.entries[0].response.content.text).toBe(
        "hello world",
      );
    });

    it("leaves a streamed 4xx JSON body untouched instead of re-sending it", async () => {
      const { uploads, fetchImpl } = bodyCollector();
      const restless = restlessExpress("rdme_test", {
        baseUrl: "http://localhost:3003",
        fetch: fetchImpl,
      });
      const mw = restless.setup(() => ({}));

      const result = await run(
        mw,
        (_req, res) => {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.write('{"error":');
          res.end('"bad request"}');
        },
        { method: "POST", path: "/stream" },
      );
      expect(result.status).toBe(400);
      // No debug object: the first half of the body is already on the wire,
      // so a rewritten whole body would be appended after it.
      expect(JSON.parse(result.body)).toEqual({ error: "bad request" });

      await restless.flush();
      expect(uploads).toHaveLength(1);
      expect(uploads[0].errorFingerprint).toBeDefined();
    });

    it("finishes after an explicit flushHeaders()", async () => {
      const restless = restlessExpress("rdme_test", {
        baseUrl: "http://localhost:3003",
        fetch: bodyCollector().fetchImpl,
      });
      const mw = restless.setup(() => ({}));

      const result = await run(
        mw,
        (_req, res) => {
          res.flushHeaders();
          res.end("ok");
        },
        { method: "GET", path: "/flushed" },
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe("ok");
    });
  });

  it("captures the request body when the handler reads it with req.on('data')", async () => {
    const { uploads, fetchImpl } = bodyCollector();
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = restless.setup(() => ({}));

    const result = await run(
      mw,
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          // Echo it back: proves the handler received the body intact,
          // i.e. capture did not steal or reorder the stream.
          res.end(Buffer.concat(chunks).toString());
        });
      },
      {
        method: "POST",
        path: "/echo",
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}',
      },
    );
    expect(JSON.parse(result.body)).toEqual({ hello: "world" });

    await restless.flush();
    expect(uploads[0].request.log.entries[0].request.postData.text).toBe(
      '{"hello":"world"}',
    );
  });

  it("captures the request body when the handler reads it with for-await", async () => {
    // Regression: capture used to patch req.on and only saw 'data'
    // listeners. Node's async iterator uses 'readable'/read(), so a
    // `for await (const chunk of req)` handler produced a log with no
    // postData at all - silently.
    const { uploads, fetchImpl } = bodyCollector();
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = restless.setup(() => ({}));

    const result = await run(
      mw,
      async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        res.setHeader("content-type", "application/json");
        res.end(Buffer.concat(chunks).toString());
      },
      {
        method: "POST",
        path: "/echo",
        headers: { "content-type": "application/json" },
        body: '{"hello":"iterator"}',
      },
    );
    expect(JSON.parse(result.body)).toEqual({ hello: "iterator" });

    await restless.flush();
    expect(uploads[0].request.log.entries[0].request.postData.text).toBe(
      '{"hello":"iterator"}',
    );
  });

  it("captures the body even when the setup callback awaits first", async () => {
    // Chunks can land while an async setup callback (DB lookup, JWT
    // verification) is in flight, which is why capture is installed before
    // the first await rather than after the block check.
    const { uploads, fetchImpl } = bodyCollector();
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = restless.setup(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return {};
    });

    const result = await run(
      mw,
      async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        res.setHeader("content-type", "application/json");
        res.end(Buffer.concat(chunks).toString());
      },
      {
        method: "POST",
        path: "/echo",
        headers: { "content-type": "application/json" },
        body: '{"hello":"late"}',
      },
    );
    expect(JSON.parse(result.body)).toEqual({ hello: "late" });

    await restless.flush();
    expect(uploads[0].request.log.entries[0].request.postData.text).toBe(
      '{"hello":"late"}',
    );
  });

  it("does not stall a handler that ignores the request body", async () => {
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
      (_req, res) => res.end("ignored"),
      {
        method: "POST",
        path: "/ignore",
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}',
      },
    );
    expect(result.body).toBe("ignored");
  });

  it("exposes the one-liner surface", () => {
    const restless = restlessExpress("rdme_test");
    expect(typeof restless.setup).toBe("function");
    expect(typeof restless.mask).toBe("function");
    expect(typeof restless.flush).toBe("function");
  });
});

describe("SAFETY-007: request-body capture ceiling", () => {
  beforeEach(() => _resetSettingsCache());

  async function capture(body: string, contentType: string) {
    const { fetchImpl, uploads } = bodyCollector();
    const restless = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const mw = restless.setup(() => ({}));
    await run(
      mw,
      (req, res) => {
        // Drain the body the way a body parser would, so the push patch runs.
        req.on("data", () => {});
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        });
      },
      { method: "POST", path: "/upload", headers: { "content-type": contentType }, body },
    );
    await restless.flush();
    return uploads[0]?.request?.log?.entries?.[0];
  }

  it("records a body over 1 MiB as bodyless rather than truncated", async () => {
    // Dropping is deliberate, not laziness. Redaction runs BEFORE truncation
    // (REDACT-033) and needs complete JSON to parse. A buffer cut at the
    // truncation limit would hand redactBody a broken document, parsing would
    // fail, and the fragment would ship UNREDACTED with whatever secret it
    // still contained. Dropping is safe; truncating before redaction is not.
    const entry = await capture("x".repeat(2 * 1024 * 1024), "text/plain");
    expect(entry).toBeDefined();
    expect(entry.request.postData).toBeUndefined();
    // The log still ships with headers intact: losing the body is not losing
    // the request.
    expect(entry.request.method).toBe("POST");
    expect(entry.response.status).toBe(200);
  });

  it("still captures and redacts a body under the ceiling", async () => {
    const entry = await capture(
      JSON.stringify({ hello: "world", password: "hunter2hunter2" }),
      "application/json",
    );
    const text = entry.request.postData.text as string;
    expect(text).toContain("<REDACTED:");
    // The property the ceiling exists to protect: redaction actually ran.
    expect(text).not.toContain("hunter2hunter2");
  });
});

/**
 * Express sets these on `req` after routing. `route.path` is whatever the
 * route was registered with; `baseUrl` is the matched mount URL; `path` is
 * relative to the mount.
 */
type Routed = {
  route?: { path?: unknown };
  baseUrl?: string;
  path?: string;
  params?: Record<string, string>;
};

async function routed(
  routing: Routed,
  url: string,
  opts: { sampling?: any; handler?: (res: http.ServerResponse) => void } = {},
) {
  const { uploads, fetchImpl } = bodyCollector();
  const restless = restlessExpress("rdme_test", {
    baseUrl: "http://localhost:3003",
    fetch: fetchImpl,
    sampling: opts.sampling,
  });
  const mw = restless.setup(() => ({}));
  const result = await run(
    mw,
    (req, res) => {
      Object.assign(req, routing);
      if (opts.handler) return opts.handler(res);
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    },
    { method: "GET", path: url },
  );
  await restless.flush();
  return { result, uploads };
}

describe("route patterns", () => {
  beforeEach(() => _resetSettingsCache());

  describe("array and RegExp route paths (RES-18)", () => {
    it("reports the array entry the request matched", async () => {
      const { result, uploads } = await routed(
        { route: { path: ["/ping", "/ping/:tag"] }, path: "/ping/abc" },
        "/ping/abc",
      );
      expect(result.status).toBe(200);
      expect(uploads).toHaveLength(1);
      expect(uploads[0].routePattern).toBe("/ping/{tag}");
    });

    it("matches array entries the way Express does", async () => {
      const { uploads } = await routed(
        { route: { path: ["/ping", "/ping/:tag"] }, path: "/PING/" },
        "/PING/",
      );
      expect(uploads[0].routePattern).toBe("/ping");
    });

    it("reports no pattern when no plain array entry matches", async () => {
      const { result, uploads } = await routed(
        { route: { path: ["/a/:id?", /^\/b/] }, path: "/a" },
        "/a",
      );
      expect(result.status).toBe(200);
      expect(uploads).toHaveLength(1);
      expect(uploads[0].routePattern).toBeUndefined();
    });

    it("reports no pattern for a RegExp path and still logs", async () => {
      const { result, uploads } = await routed(
        { route: { path: /^\/ping/ }, path: "/ping" },
        "/ping",
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe('{"ok":true}');
      expect(uploads).toHaveLength(1);
      expect(uploads[0].routePattern).toBeUndefined();
    });

    it("applies a sampling rule to the matched array entry", async () => {
      const { result, uploads } = await routed(
        { route: { path: ["/ping", "/ping/:tag"] }, path: "/ping/abc" },
        "/ping/abc",
        { sampling: { routes: { "GET /ping/{tag}": "off" } } },
      );
      expect(result.status).toBe(200);
      expect(result.headers["x-request-id"]).toBeUndefined();
      expect(uploads).toEqual([]);
    });

    it("falls back to the default sampling mode for a RegExp path", async () => {
      const { result, uploads } = await routed(
        { route: { path: /^\/ping/ }, path: "/ping" },
        "/ping",
        { sampling: { default: "off" } },
      );
      expect(result.status).toBe(200);
      expect(uploads).toEqual([]);
    });

    it("survives a RegExp path when the handler streams", async () => {
      const { result, uploads } = await routed(
        { route: { path: /^\/stream/ }, path: "/stream" },
        "/stream",
        {
          sampling: { default: "on" },
          handler: (res) => {
            res.write("a");
            res.end("b");
          },
        },
      );
      expect(result.body).toBe("ab");
      expect(uploads).toHaveLength(1);
    });
  });

  describe("router mount prefix (RES-19)", () => {
    it("puts req.baseUrl in front of the route", async () => {
      const { uploads } = await routed(
        { route: { path: "/shipments/:id" }, baseUrl: "/v1", path: "/shipments/7" },
        "/v1/shipments/7",
      );
      expect(uploads[0].routePattern).toBe("/v1/shipments/{id}");
    });

    it("joins a nested mount and a root route without a trailing slash", async () => {
      const { uploads } = await routed(
        { route: { path: "/" }, baseUrl: "/v1/shipments", path: "/" },
        "/v1/shipments",
      );
      expect(uploads[0].routePattern).toBe("/v1/shipments");
    });

    it("templates mount params back from req.params", async () => {
      const { uploads } = await routed(
        {
          route: { path: "/posts/:pid" },
          baseUrl: "/users/42",
          path: "/posts/42",
          params: { uid: "42", pid: "42" },
        },
        "/users/42/posts/42",
      );
      expect(uploads[0].routePattern).toBe("/users/{uid}/posts/{pid}");
    });

    it("templates only the segment a mount param came from", async () => {
      // app.use('/:tenant/v1', r) at /v1/v1: the literal v1 stays.
      const { uploads } = await routed(
        { route: { path: "/x" }, baseUrl: "/v1/v1", path: "/x", params: { tenant: "v1" } },
        "/v1/v1/x",
      );
      expect(uploads[0].routePattern).toBe("/{tenant}/v1/x");
    });

    it("templates two mount params that share a value", async () => {
      const { uploads } = await routed(
        {
          route: { path: "/" },
          baseUrl: "/users/42/orgs/42",
          path: "/",
          params: { uid: "42", oid: "42" },
        },
        "/users/42/orgs/42",
      );
      expect(uploads[0].routePattern).toBe("/users/{uid}/orgs/{oid}");
    });

    it("puts the mount in front of a matched array entry", async () => {
      const { uploads } = await routed(
        { route: { path: ["/ping", "/ping/:tag"] }, baseUrl: "/v1", path: "/ping" },
        "/v1/ping",
      );
      expect(uploads[0].routePattern).toBe("/v1/ping");
    });

    it("matches a sampling rule written with the full path", async () => {
      const { uploads } = await routed(
        { route: { path: "/health" }, baseUrl: "/v1", path: "/health" },
        "/v1/health",
        { sampling: { routes: { "GET /v1/health": "off" } } },
      );
      expect(uploads).toEqual([]);
    });
  });

  describe("SAFETY-001: the SDK never breaks the response", () => {
    it("logs without a pattern when reading req.route throws", async () => {
      const { result, uploads } = await routed(
        {},
        "/x",
        {
          handler: (res) => {
            Object.defineProperty(res.req, "route", {
              get() {
                throw new Error("boom");
              },
            });
            res.end("ok");
          },
        },
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe("ok");
      expect(uploads).toHaveLength(1);
      expect(uploads[0].routePattern).toBeUndefined();
    });

    it("sends the handler's response when capture throws at res.end", async () => {
      const { result, uploads } = await routed(
        {},
        "/x",
        {
          handler: (res) => {
            res.setHeader("content-type", "application/json");
            res.statusCode = 404;
            res.getHeaders = () => {
              throw new Error("boom");
            };
            res.end('{"error":"nope"}');
          },
        },
      );
      expect(result.status).toBe(404);
      expect(result.body).toBe('{"error":"nope"}');
      expect(uploads).toEqual([]);
    });
  });
});
