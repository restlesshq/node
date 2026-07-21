import { describe, it, expect, vi, beforeEach } from "vitest";
import restless from "../src/index.js";
import { _resetSettingsCache } from "../src/lib/settings.js";

/**
 * Minimal mock Fastify with an addHook implementation that respects the
 * skip-override symbol on the plugin (so the SDK's hooks register on the
 * parent, not an encapsulated child). Lets us simulate real hook ordering
 * end-to-end without pulling Fastify in as a test dep.
 */
function mockFastify() {
  const hooks: Record<string, Function[]> = {};
  return {
    addHook(name: string, fn: Function) {
      hooks[name] ||= [];
      hooks[name]!.push(fn);
    },
    decorateRequest() {},
    async register(plugin: any) {
      // Real Fastify checks for the skip-override symbol and runs the
      // plugin against the parent context if it's set. The SDK plugin
      // always sets it.
      await plugin(this);
    },
    hooks,
  };
}

describe("fastify adapter: hook ordering with user auth", () => {
  beforeEach(() => _resetSettingsCache());

  it("setup callback sees req.user when auth onRequest is registered AFTER the SDK plugin", async () => {
    // This is the bug the user hit. Reproduces the test-api wiring:
    //
    //   fastify.register(restless.setup(cb))   // SDK first
    //   fastify.addHook("onRequest", auth)     // auth second
    //
    // Pre-fix the SDK's onRequest fired before auth, so req.user was
    // undefined when the setup callback ran. After splitting onRequest
    // and preHandler, the setup callback runs in preHandler, after every
    // onRequest hook has had a chance to attach state.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    const client = restless("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    let observedUser: unknown = "<setup-never-ran>";
    const cb = vi.fn((req: any) => {
      observedUser = req.user;
      return {
        apiKey: "masked",
        owner: req.user ? { id: req.user.id } : undefined,
      };
    });
    const plugin = client.setup(cb);

    const app = mockFastify();
    await app.register(plugin);

    // The user's auth hook, registered AFTER the SDK plugin.
    app.addHook("onRequest", async (req: any) => {
      req.user = { id: "user-42" };
    });

    // Simulate a request lifecycle.
    const req: any = {
      headers: { host: "localhost", authorization: "Bearer xyz" },
      raw: { socket: {}, method: "GET", url: "/pets" },
      url: "/pets",
    };
    const reply: any = { header: () => reply, code: () => reply };
    for (const h of app.hooks.onRequest!) await h(req, reply);
    for (const h of (app.hooks.preHandler || [])) await h(req, reply);

    expect(cb).toHaveBeenCalled();
    expect(observedUser).toEqual({ id: "user-42" });
  });

  it("preHandler also runs when the SDK plugin is registered AFTER auth", async () => {
    // Sanity check: the original "register before auth" advice still
    // works post-fix, so existing users don't regress.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    const client = restless("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    let observedUser: unknown = "<setup-never-ran>";
    const cb = vi.fn((req: any) => {
      observedUser = req.user;
      return { apiKey: "masked", owner: req.user && { id: req.user.id } };
    });
    const plugin = client.setup(cb);

    const app = mockFastify();
    // Auth FIRST.
    app.addHook("onRequest", async (req: any) => {
      req.user = { id: "user-7" };
    });
    // SDK plugin SECOND.
    await app.register(plugin);

    const req: any = {
      headers: { host: "localhost" },
      raw: { socket: {}, method: "GET", url: "/x" },
      url: "/x",
    };
    const reply: any = { header: () => reply, code: () => reply };
    for (const h of app.hooks.onRequest!) await h(req, reply);
    for (const h of (app.hooks.preHandler || [])) await h(req, reply);

    expect(observedUser).toEqual({ id: "user-7" });
  });

  it("does NOT call the setup callback if an earlier onRequest short-circuits (no preHandler)", async () => {
    // If a user auth hook throws or replies in onRequest, Fastify skips
    // the rest of the request lifecycle (no preHandler). The setup
    // callback never runs. The log still gets recorded by onSend with
    // an empty user, which is correct because there is no owner.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    const client = restless("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const cb = vi.fn().mockReturnValue({ apiKey: "k" });
    const plugin = client.setup(cb);

    const app = mockFastify();
    await app.register(plugin);

    const req: any = {
      headers: { host: "localhost" },
      raw: { socket: {}, method: "GET", url: "/x" },
      url: "/x",
    };
    const reply: any = { header: () => reply, code: () => reply };

    // Only the SDK's onRequest runs; preHandler is intentionally not invoked
    // here, simulating an auth hook that already sent a response.
    for (const h of app.hooks.onRequest!) await h(req, reply);

    expect(cb).not.toHaveBeenCalled();
    // req._restless is allocated, but state.setup is still null.
    expect((req as any)._restless).toBeTruthy();
    expect((req as any)._restless.setup).toBeNull();
  });

  it("captures a circular multipart body without throwing (records body undefined)", async () => {
    // Regression: @fastify/multipart with attachFieldsToBody gives each file
    // a `.fields` back-pointer, so `req.body` is circular. Pre-fix,
    // `JSON.stringify(req.body)` threw inside onSend, rejecting the hook and
    // 500ing the request — the observability layer breaking the request path.
    let uploaded: any;
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      uploaded = JSON.parse(init.body);
      return { ok: true, text: async () => "" } as any;
    });
    const client = restless("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const plugin = client.setup(() => ({ apiKey: "k" }));

    const app = mockFastify();
    await app.register(plugin);

    // Build the circular body: body.schema.fields === body.
    const file: any = { type: "file", filename: "a.png" };
    const fields: any = { schema: file };
    file.fields = fields;

    const req: any = {
      headers: {
        host: "localhost",
        "content-type": "multipart/form-data; boundary=----x",
      },
      raw: { socket: {}, method: "POST", url: "/upload" },
      url: "/upload",
      body: fields,
    };
    const resHeaders: Record<string, string> = {};
    const reply: any = {
      statusCode: 200,
      header: (k: string, v: string) => {
        resHeaders[k] = v;
        return reply;
      },
      getHeaders: () => resHeaders,
      code: () => reply,
    };

    for (const h of app.hooks.onRequest!) await h(req, reply);
    for (const h of (app.hooks.preHandler || [])) await h(req, reply);

    // The request completes normally: onSend returns the payload, no throw.
    let out: unknown;
    await expect(
      (async () => {
        for (const h of app.hooks.onSend!) out = await h(req, reply, "ok");
      })(),
    ).resolves.toBeUndefined();
    expect(out).toBe("ok");

    await client.flush();
    expect(fetchImpl).toHaveBeenCalled();
    const entry = uploaded[0].request.log.entries[0];
    // No postData recorded because the body dropped to undefined.
    expect(entry.request.postData).toBeUndefined();
  });

  it("blocking in the setup callback short-circuits in preHandler", async () => {
    // The block API still works after the split. preHandler runs before
    // the route handler, so reply.code/.send from the SDK still wins.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    const client = restless("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const cb = vi.fn().mockReturnValue({ block: { status: 403, message: "no" } });
    const plugin = client.setup(cb);

    const app = mockFastify();
    await app.register(plugin);

    const req: any = {
      headers: { host: "localhost" },
      raw: { socket: {}, method: "GET", url: "/x" },
      url: "/x",
    };
    let sent: { status?: number; type?: string; body?: unknown } = {};
    const reply: any = {
      code: (s: number) => { sent.status = s; return reply; },
      type: (t: string) => { sent.type = t; return reply; },
      send: (b: unknown) => { sent.body = b; return reply; },
      header: () => reply,
    };

    for (const h of app.hooks.onRequest!) await h(req, reply);
    for (const h of (app.hooks.preHandler || [])) await h(req, reply);

    expect(cb).toHaveBeenCalled();
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({ error: "no" });
  });
});
