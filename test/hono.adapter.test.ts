import { describe, it, expect, vi, beforeEach } from "vitest";
import restlessHono from "../src/adapters/hono.js";
import { _resetSettingsCache } from "../src/lib/settings.js";

/**
 * Collects what the SDK uploads so tests can assert on the wire payload,
 * answering with a portal origin the way the server does.
 */
function collector() {
  const uploads: any[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: any) => {
    uploads.push(...JSON.parse(init.body));
    return {
      ok: true,
      text: async () => "",
      json: async () => ({ docsUrl: "https://acme.restlessdocs.com" }),
    } as any;
  });
  return { uploads, fetchImpl: fetchImpl as unknown as typeof fetch };
}

// Handlers shaped like the ones Hono registers: middleware takes `next`,
// an endpoint does not.
const mw = (_c: unknown, _next: unknown) => {};
const endpoint = (_c: unknown) => {};

type Route = { method: string; path: string; handler: Function };

/**
 * Run one request through the SDK middleware with a context shaped like
 * Hono's: `matchedRoutes` is every route the router matched for the path,
 * `routeIndex` the one that responded. Without Hono as a test dep, this is
 * the state the real framework hands the middleware after `await next()`.
 */
async function run(opts: {
  path: string;
  status: number;
  routes?: Route[];
  routeIndex?: number;
  routePath?: string;
  sampling?: unknown;
  /** Round-trip one upload first, so the client knows the portal origin. */
  warm?: boolean;
}) {
  const { uploads, fetchImpl } = collector();
  const client = restlessHono("rdme_test", {
    baseUrl: "http://localhost:3003",
    fetch: fetchImpl,
    ...(opts.sampling ? { sampling: opts.sampling } : {}),
  } as any);
  const handle = client.setup(() => ({ apiKey: "k" }));

  if (opts.warm) {
    const w: any = {
      req: { raw: new Request("http://localhost/warm"), routePath: "/warm" },
      header: () => {},
    };
    await handle(w, async () => {
      w.res = new Response("{}");
    });
    await client.flush();
    uploads.length = 0;
  }

  const req: any = {
    raw: new Request(`http://localhost${opts.path}`),
    routeIndex: 0,
  };
  if (opts.routes) {
    req.matchedRoutes = opts.routes;
    req.routePath =
      opts.routePath ?? opts.routes[opts.routeIndex ?? 0]?.path ?? "";
  } else {
    req.routePath = opts.routePath;
  }
  const c: any = { req, res: undefined, header: () => {} };

  await handle(c, async () => {
    req.routeIndex = opts.routeIndex ?? 0;
    c.res = new Response('{"error":"x"}', {
      status: opts.status,
      headers: { "content-type": "application/json" },
    });
  });
  await client.flush();
  return { uploads, body: await (c.res as Response).text() };
}

beforeEach(() => {
  _resetSettingsCache();
});

describe("hono route patterns (RES-20)", () => {
  const chain: Route[] = [
    { method: "ALL", path: "/*", handler: mw },
    { method: "ALL", path: "/v1/*", handler: mw },
    { method: "GET", path: "/v1/shipments/:id", handler: endpoint },
  ];

  it("reports the endpoint when it responded", async () => {
    const { uploads } = await run({
      path: "/v1/shipments/shp_1",
      status: 200,
      routes: chain,
      routeIndex: 2,
    });
    expect(uploads[0].routePattern).toBe("/v1/shipments/:id");
  });

  it("reports the endpoint, not the middleware, when middleware answers first", async () => {
    const { uploads } = await run({
      path: "/v1/shipments/shp_1",
      status: 401,
      routes: chain,
      routeIndex: 1,
    });
    expect(uploads[0].routePattern).toBe("/v1/shipments/:id");
  });

  it("reports no pattern for a 404 that matched only middleware", async () => {
    const { uploads } = await run({
      path: "/v1/nope",
      status: 404,
      routes: chain.slice(0, 2),
      routeIndex: 1,
    });
    expect(uploads[0].routePattern).toBeUndefined();
  });

  it("takes the first endpoint matched, the one Hono dispatches to", async () => {
    const { uploads } = await run({
      path: "/v1/shipments/latest",
      status: 429,
      routes: [
        chain[1],
        { method: "GET", path: "/v1/shipments/latest", handler: endpoint },
        chain[2],
      ],
      routeIndex: 0,
    });
    expect(uploads[0].routePattern).toBe("/v1/shipments/latest");
  });

  it("counts an app.all handler as an endpoint", async () => {
    const { uploads } = await run({
      path: "/webhook",
      status: 401,
      routes: [
        { method: "ALL", path: "/*", handler: mw },
        { method: "ALL", path: "/webhook", handler: endpoint },
      ],
      routeIndex: 0,
    });
    expect(uploads[0].routePattern).toBe("/webhook");
  });

  it("applies the endpoint's sampling rule to a request middleware rejected", async () => {
    const { uploads } = await run({
      path: "/v1/shipments/shp_1",
      status: 401,
      routes: chain,
      routeIndex: 1,
      sampling: { routes: { "GET /v1/shipments/{id}": "off" } },
    });
    expect(uploads).toHaveLength(0);
  });

  it("points the debug link at the endpoint", async () => {
    const { body } = await run({
      path: "/v1/shipments/shp_1",
      status: 401,
      routes: chain,
      routeIndex: 1,
      warm: true,
    });
    expect(body).toContain("get-v1-shipments-id");
  });

  it("falls back to routePath on a context without matchedRoutes", async () => {
    const { uploads } = await run({
      path: "/boom",
      status: 500,
      routePath: "/boom",
    });
    expect(uploads[0].routePattern).toBe("/boom");
  });

  it("logs without a pattern when reading the routes throws (SAFETY-001)", async () => {
    const routes = new Proxy([] as Route[], {
      get() {
        throw new Error("nope");
      },
    });
    const { uploads } = await run({
      path: "/x",
      status: 401,
      routes: routes as any,
      routePath: "/*",
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].routePattern).toBeUndefined();
  });
});
