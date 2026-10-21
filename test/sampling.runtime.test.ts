import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import restless from "../src/index.js";
import restlessExpress from "../src/adapters/express.js";
import restlessKoa from "../src/adapters/koa.js";
import restlessHono from "../src/adapters/hono.js";
import restlessNext from "../src/adapters/next.js";
import { _resetSettingsCache, resolveApi } from "../src/lib/settings.js";
import type { ClientOptions } from "../src/types.js";

/**
 * Sampling at runtime (CONTRACT.md section 12.1), through every adapter.
 * The decision logic itself is pinned by spec/vectors/sampling.json; this
 * file is about what each adapter DOES with the outcome: which headers go
 * out, what gets uploaded, and the config report.
 */

const SAMPLING = {
  routes: {
    "GET /health": "off",
    "GET /status": "errors",
    "GET /pets": 0.5,
  },
} as const;

/** Every fetch the SDK makes, split by endpoint. */
function collector(respond: () => unknown = () => ({})) {
  const uploads: any[] = [];
  const uploadHeaders: Record<string, string>[] = [];
  const reports: any[] = [];
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    if (url.endsWith("/v1/sampling")) reports.push(JSON.parse(init.body));
    else {
      uploads.push(...JSON.parse(init.body));
      uploadHeaders.push(init.headers);
    }
    return { ok: true, text: async () => "", json: async () => respond() } as any;
  });
  return { uploads, uploadHeaders, reports, fetchImpl: fetchImpl as unknown as typeof fetch };
}

interface Exchange {
  method?: string;
  path: string;
  status?: number;
  body?: string;
}

interface Driven {
  headers: Record<string, string>;
  body: string;
  flush: () => Promise<void>;
}

type Driver = (opts: ClientOptions, ex: Exchange) => Promise<Driven>;

const JSON_CT = "application/json";

// ---------------------------------------------------------------------------
// One minimal driver per adapter. Each serves a single request whose route
// pattern is the literal path, the way the framework would report it.
// ---------------------------------------------------------------------------

const express: Driver = async (opts, ex) => {
  const client = restlessExpress("rdme_test", opts);
  const mw = client.setup(() => ({}));
  const server = http.createServer((req, res) => {
    mw(req, res, () => {
      (req as any).route = { path: ex.path };
      res.statusCode = ex.status ?? 200;
      res.setHeader("content-type", JSON_CT);
      res.end(ex.body ?? '{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${ex.path}`, { method: ex.method ?? "GET" });
    return {
      headers: Object.fromEntries(res.headers.entries()),
      body: await res.text(),
      flush: () => client.flush(),
    };
  } finally {
    server.close();
  }
};

const fastify: Driver = async (opts, ex) => {
  const client = restless("rdme_test", opts);
  const plugin = client.setup(() => ({})) as any;
  const hooks: Record<string, Function[]> = {};
  await plugin({
    addHook: (n: string, fn: Function) => (hooks[n] ||= []).push(fn),
    decorateRequest() {},
  });
  const headers: Record<string, string> = { "content-type": JSON_CT };
  const req: any = {
    headers: { host: "localhost" },
    raw: { socket: {}, method: ex.method ?? "GET", url: ex.path },
    url: ex.path,
    routeOptions: { url: ex.path },
  };
  const reply: any = {
    statusCode: ex.status ?? 200,
    header: (k: string, v: string) => ((headers[k] = v), reply),
    removeHeader: (k: string) => delete headers[k],
    getHeaders: () => headers,
    code: () => reply,
  };
  for (const h of hooks.onRequest!) await h(req, reply);
  for (const h of hooks.preHandler || []) await h(req, reply);
  let payload: unknown = ex.body ?? '{"ok":true}';
  for (const h of hooks.onSend!) payload = await h(req, reply, payload);
  return { headers, body: String(payload), flush: () => client.flush() };
};

const koa: Driver = async (opts, ex) => {
  const client = restlessKoa("rdme_test", opts);
  const mw = client.setup(() => ({}));
  const headers: Record<string, string> = {};
  const ctx: any = {
    protocol: "http",
    host: "localhost",
    originalUrl: ex.path,
    url: ex.path,
    method: ex.method ?? "GET",
    status: 200,
    body: undefined,
    request: { headers: { host: "localhost" }, body: undefined },
    response: { headers },
    set: (k: string, v: string) => (headers[k] = v),
    remove: (k: string) => delete headers[k],
  };
  await mw(ctx, async () => {
    ctx._matchedRoute = ex.path;
    ctx.status = ex.status ?? 200;
    headers["content-type"] = JSON_CT;
    ctx.body = JSON.parse(ex.body ?? '{"ok":true}');
  });
  return { headers, body: JSON.stringify(ctx.body), flush: () => client.flush() };
};

const hono: Driver = async (opts, ex) => {
  const client = restlessHono("rdme_test", opts);
  const mw = client.setup(() => ({}));
  // Hono collects headers set before the response exists and applies them
  // to it; after that, c.header writes the response directly.
  const pending: Record<string, string | undefined> = {};
  const c: any = {
    req: { raw: new Request(`http://localhost${ex.path}`, { method: ex.method ?? "GET" }), routePath: ex.path },
    res: undefined,
    header: (k: string, v: string | undefined) => {
      if (c.res) v === undefined ? c.res.headers.delete(k) : c.res.headers.set(k, v);
      else pending[k] = v;
    },
  };
  await mw(c, async () => {
    c.res = new Response(ex.body ?? '{"ok":true}', {
      status: ex.status ?? 200,
      headers: { "content-type": JSON_CT },
    });
    for (const [k, v] of Object.entries(pending)) if (v !== undefined) c.res.headers.set(k, v);
  });
  return {
    headers: Object.fromEntries((c.res as Response).headers.entries()),
    body: await (c.res as Response).text(),
    flush: () => client.flush(),
  };
};

const next: Driver = async (opts, ex) => {
  const client = restlessNext("rdme_test", opts);
  const wrap = client.setup(() => ({}));
  const handler = wrap(
    async () =>
      new Response(ex.body ?? '{"ok":true}', {
        status: ex.status ?? 200,
        headers: { "content-type": JSON_CT },
      }),
  );
  const res: Response = await (handler as any)(
    new Request(`http://localhost${ex.path}`, { method: ex.method ?? "GET" }),
    { params: Promise.resolve({}) },
  );
  return {
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.text(),
    flush: () => client.flush(),
  };
};

const DRIVERS: Record<string, Driver> = { express, fastify, koa, hono, next };

const hasIdHeader = (h: Record<string, string>) =>
  "x-request-id" in h || "x-restless-id" in h;

beforeEach(() => _resetSettingsCache());
afterEach(() => vi.restoreAllMocks());

for (const [name, drive] of Object.entries(DRIVERS)) {
  describe(`sampling through ${name}`, () => {
    const opts = (fetchImpl: typeof fetch): ClientOptions => ({
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
      sampling: SAMPLING as ClientOptions["sampling"],
    });

    it('"off": the response goes out untouched, with no id header and no log', async () => {
      const { uploads, fetchImpl } = collector();
      const out = await drive(opts(fetchImpl), { path: "/health" });
      await out.flush();
      expect(hasIdHeader(out.headers)).toBe(false);
      expect(out.headers["x-debug"]).toBeUndefined();
      expect(out.headers["x-api-feedback"]).toBeUndefined();
      expect(JSON.parse(out.body)).toEqual({ ok: true });
      expect(uploads).toEqual([]);
    });

    it('"off" drops errors too', async () => {
      const { uploads, fetchImpl } = collector();
      const out = await drive(opts(fetchImpl), { path: "/health", status: 503, body: '{"error":"down"}' });
      await out.flush();
      expect(hasIdHeader(out.headers)).toBe(false);
      expect(JSON.parse(out.body)).toEqual({ error: "down" });
      expect(uploads).toEqual([]);
    });

    it('"errors": a success is dropped, headers and all', async () => {
      const { uploads, fetchImpl } = collector();
      const out = await drive(opts(fetchImpl), { path: "/status" });
      await out.flush();
      expect(hasIdHeader(out.headers)).toBe(false);
      expect(uploads).toEqual([]);
    });

    it('"errors": an error is sent in full', async () => {
      const { uploads, fetchImpl } = collector();
      const out = await drive(opts(fetchImpl), { path: "/status", status: 404, body: '{"error":"nope"}' });
      await out.flush();
      expect(hasIdHeader(out.headers)).toBe(true);
      expect(uploads).toHaveLength(1);
      expect(uploads[0].sampled).toBeUndefined();
      expect(uploads[0].errorFingerprint).toBeDefined();
    });

    it("a rate miss uploads a bodyless stub, still headered", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const { uploads, fetchImpl } = collector();
      const out = await drive(opts(fetchImpl), { path: "/pets", body: '{"pets":[1,2]}' });
      await out.flush();
      // The stub is a real log, so the caller can still be pointed at it.
      expect(hasIdHeader(out.headers)).toBe(true);
      expect(JSON.parse(out.body)).toEqual({ pets: [1, 2] });
      expect(uploads).toHaveLength(1);
      expect(uploads[0].sampled).toBe(true);
      const entry = uploads[0].request.log.entries[0];
      expect(entry.request.postData).toBeUndefined();
      expect(entry.response.content.text).toBe("");
      expect(entry.response.bodySize).toBe(-1);
      expect(entry.response.status).toBe(200);
    });

    it("a rate hit uploads in full", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.1);
      const { uploads, fetchImpl } = collector();
      const out = await drive(opts(fetchImpl), { path: "/pets", body: '{"pets":[1,2]}' });
      await out.flush();
      expect(uploads).toHaveLength(1);
      expect(uploads[0].sampled).toBeUndefined();
      expect(JSON.parse(uploads[0].request.log.entries[0].response.content.text)).toEqual({ pets: [1, 2] });
    });

    it("an unconfigured route uses the default", async () => {
      const { uploads, fetchImpl } = collector();
      const out = await drive(opts(fetchImpl), { path: "/orders" });
      await out.flush();
      expect(hasIdHeader(out.headers)).toBe(true);
      expect(uploads).toHaveLength(1);
      expect(uploads[0].sampled).toBeUndefined();
    });

    it("draws u once per request (SAMPLE-032)", async () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
      const { fetchImpl } = collector();
      const out = await drive(opts(fetchImpl), { path: "/pets" });
      await out.flush();
      expect(random).toHaveBeenCalledTimes(1);
    });
  });
}

describe("the config report and the upload header", () => {
  const SAMPLING_HASH = /^[0-9a-f]{64}$/;

  it("reports once per process, on the first request, with the normalized config", async () => {
    const { reports, uploadHeaders, fetchImpl } = collector();
    const opts: ClientOptions = {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
      sampling: { routes: { "get /pets/:id/": 0.25, "GET /health": "off" } },
    };
    const client = restlessNext("rdme_test", opts);
    const handler = client.setup(() => ({}))(async () => new Response("{}"));
    // Constructing and wrapping sends nothing (SAMPLE-051).
    expect(reports).toEqual([]);

    for (let i = 0; i < 3; i++) {
      await (handler as any)(new Request("http://localhost/orders"), { params: Promise.resolve({}) });
    }
    await client.flush();
    await new Promise((r) => setTimeout(r, 0));

    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      hash: expect.stringMatching(SAMPLING_HASH),
      default: "on",
      routes: { "GET /health": "off", "GET /pets/{id}": 0.25 },
      creator: { name: "@restlessai/sdk", version: expect.any(String) },
    });
    expect(uploadHeaders.length).toBeGreaterThan(0);
    for (const h of uploadHeaders) expect(h["x-restless-sampling"]).toBe(reports[0].hash);
  });

  it("re-sends the report when the ingest asks (needsSamplingConfig)", async () => {
    let ask = true;
    const { reports, fetchImpl } = collector(() => {
      const body = { needsSamplingConfig: ask };
      ask = false;
      return body;
    });
    const client = restlessNext("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
      sampling: { default: "errors" },
    });
    const handler = client.setup(() => ({}))(async () => new Response("{}", { status: 500 }));
    const call = () => (handler as any)(new Request("http://localhost/x"), { params: Promise.resolve({}) });

    await call();
    await client.flush();
    await new Promise((r) => setTimeout(r, 0));
    await call();
    await client.flush();
    await new Promise((r) => setTimeout(r, 0));

    // First report on the first request, then exactly one re-send for the
    // one response that asked.
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual(reports[0]);
  });

  it("sends no report and no header without sampling configured (SAMPLE-041)", async () => {
    const { reports, uploadHeaders, fetchImpl } = collector(() => ({ needsSamplingConfig: true }));
    const client = restlessNext("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
      sampling: { default: "on", routes: {} },
    });
    const handler = client.setup(() => ({}))(async () => new Response("{}"));
    await (handler as any)(new Request("http://localhost/x"), { params: Promise.resolve({}) });
    await client.flush();
    await new Promise((r) => setTimeout(r, 0));

    expect(reports).toEqual([]);
    expect(uploadHeaders).toHaveLength(1);
    expect(uploadHeaders[0]!["x-restless-sampling"]).toBeUndefined();
  });

  it("a failed report never reaches the request path", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/sampling")) throw new Error("ECONNREFUSED");
      return { ok: true, text: async () => "", json: async () => ({}) } as any;
    });
    const client = restlessNext("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
      sampling: { default: 0.5 },
    });
    const handler = client.setup(() => ({}))(async () => new Response('{"ok":1}'));
    const res: Response = await (handler as any)(new Request("http://localhost/x"), {
      params: Promise.resolve({}),
    });
    expect(await res.text()).toBe('{"ok":1}');
  });
});

describe("sampling from .restless/settings.json", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("resolveApi carries the sampling block through", () => {
    const picked = resolveApi({
      version: 1,
      apis: [{ id: "a1", name: "Solo", sampling: { default: "errors" } }],
    });
    expect(picked?.sampling).toEqual({ default: "errors" });
  });

  it("merges with code, code winning per route", async () => {
    dir = mkdtempSync(join(tmpdir(), "restless-sampling-"));
    mkdirSync(join(dir, ".restless"));
    writeFileSync(
      join(dir!, ".restless", "settings.json"),
      JSON.stringify({
        version: 1,
        apis: [{ id: "a1", name: "Solo", sampling: { routes: { "GET /a": "off", "GET /b": "off" } } }],
      }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(dir!);

    const { reports, fetchImpl } = collector();
    const client = restlessNext("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
      sampling: { routes: { "GET /b": "on" } },
    });
    const handler = client.setup(() => ({}))(async () => new Response("{}"));
    await (handler as any)(new Request("http://localhost/a"), { params: Promise.resolve({}) });
    await new Promise((r) => setTimeout(r, 0));

    expect(reports[0].routes).toEqual({ "GET /a": "off", "GET /b": "on" });
  });
});

describe("hono: a dropped request that throws", () => {
  it("takes back the queued id header before Hono's onError builds the response", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessHono("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
      sampling: { routes: { "GET /boom": "off" } },
    });
    const mw = client.setup(() => ({}));
    // Like Hono's Context: headers set before a response exists are queued,
    // and the response app.onError builds afterwards carries them.
    const queued = new Headers();
    const c: any = {
      req: { raw: new Request("http://localhost/boom"), routePath: "/boom" },
      res: undefined,
      header: (k: string, v: string | undefined) =>
        v === undefined ? queued.delete(k) : queued.set(k, v),
    };
    const err = new Error("boom");
    await expect(mw(c, async () => { throw err; })).rejects.toBe(err);
    const onErrorResponse = new Response("Internal Server Error", { status: 500, headers: queued });

    await client.flush();
    expect(hasIdHeader(Object.fromEntries(onErrorResponse.headers.entries()))).toBe(false);
    expect(uploads).toEqual([]);
  });
});

describe("koa: a dropped request that throws", () => {
  it("takes back the id header for an upstream try/catch that responds itself", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessKoa("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
      sampling: { routes: { "GET /boom": "off" } },
    });
    const mw = client.setup(() => ({}));
    const headers: Record<string, string> = {};
    const ctx: any = {
      protocol: "http",
      host: "localhost",
      originalUrl: "/boom",
      url: "/boom",
      method: "GET",
      status: 404,
      request: { headers: { host: "localhost" } },
      response: { headers },
      set: (k: string, v: string) => (headers[k] = v),
      remove: (k: string) => delete headers[k],
    };
    // The usual Koa error middleware: catch, then respond without onerror.
    try {
      await mw(ctx, async () => {
        ctx._matchedRoute = "/boom";
        throw new Error("boom");
      });
    } catch {
      ctx.status = 500;
      ctx.body = { error: "handled" };
    }

    await client.flush();
    expect(hasIdHeader(headers)).toBe(false);
    expect(uploads).toEqual([]);
  });
});

describe("express: deciding when the handler streams", () => {
  it("takes the id header back in writeHead, before the first byte", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
      sampling: { routes: { "GET /stream": "off" } },
    });
    const mw = client.setup(() => ({}));
    const server = http.createServer((req, res) => {
      mw(req, res, () => {
        (req as any).route = { path: "/stream" };
        // write() sends the headers, so res.end is too late to decide.
        res.write("a");
        res.end("b");
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/stream`);
      expect(await res.text()).toBe("ab");
      expect(res.headers.has("x-request-id")).toBe(false);
    } finally {
      server.close();
    }
    await client.flush();
    expect(uploads).toEqual([]);
  });
});
