import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "node:http";
import restless from "../src/index.js";
import restlessExpress from "../src/adapters/express.js";
import restlessKoa from "../src/adapters/koa.js";
import restlessHono from "../src/adapters/hono.js";
import restlessHttp from "../src/adapters/http.js";
import restlessNext from "../src/adapters/next.js";
import { _resetSettingsCache } from "../src/lib/settings.js";

/**
 * A handler that throws must (a) still produce a log and (b) fingerprint by
 * throw site - the `stack` strategy - instead of collapsing into the
 * normalized text of whatever error page the framework rendered. Python and
 * Go both populate the stack; the reference implementation never did, so
 * the identical crash grouped differently in every SDK.
 *
 * The other half of every case here is SAFETY-001: the exception the
 * framework sees must be the exact object the handler threw.
 */

/** Collects what the SDK uploads so tests can assert on the wire payload. */
function collector() {
  const uploads: any[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: any) => {
    uploads.push(...JSON.parse(init.body));
    return { ok: true, text: async () => "", json: async () => ({}) } as any;
  });
  return { uploads, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** Named so the frame it produces is recognizable in the fingerprint key. */
function crashInHandler(): never {
  throw new Error("kaboom 42");
}

describe("thrown handlers: stack fingerprint + a log at all", () => {
  beforeEach(() => _resetSettingsCache());

  it("express: errorHandler stashes the error, the log fingerprints by stack", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = client.setup(() => ({ apiKey: "k" }));

    const thrown = new Error("kaboom 42");
    let seenByExpress: unknown;

    // Mini-Express: route throws → next(err) → error middleware chain →
    // final handler writes the 500. Real Express does exactly this, and
    // this is the ordering that makes the capture middleware unable to see
    // the error without `errorHandler` being registered.
    const server = http.createServer((req, res) => {
      mw(req, res, () => {
        try {
          crashInHandler();
        } catch (err) {
          client.errorHandler(err, req, res, (e) => {
            seenByExpress = e;
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end('{"error":"Internal Server Error"}');
          });
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/boom`);
      expect(res.status).toBe(500);
    } finally {
      server.close();
    }
    await client.flush();

    expect((seenByExpress as Error).message).toBe(thrown.message);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].errorFingerprint.strategy).toBe("stack");
    expect(uploads[0].errorFingerprint.key).toContain("crashInHandler");
    expect(uploads[0].errorFingerprint.key).toMatch(/^500:/);
  });

  it("express: without the errorHandler it still logs, just by message", async () => {
    // The capture middleware has already returned by the time Express
    // routes the error, so this is the honest before-picture. It must stay
    // a working log, not a crash.
    const { uploads, fetchImpl } = collector();
    const client = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = client.setup(() => ({ apiKey: "k" }));

    const server = http.createServer((req, res) => {
      mw(req, res, () => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end('{"error":"Internal Server Error"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      await fetch(`http://127.0.0.1:${port}/boom`);
    } finally {
      server.close();
    }
    await client.flush();

    expect(uploads[0].errorFingerprint.strategy).toBe("message");
  });

  it("express: the stack is used locally but never uploaded", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessExpress("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = client.setup(() => ({ apiKey: "k" }));

    const server = http.createServer((req, res) => {
      mw(req, res, () => {
        try {
          crashInHandler();
        } catch (err) {
          client.errorHandler(err, req, res, () => {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end('{"error":"boom"}');
          });
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      await fetch(`http://127.0.0.1:${port}/boom`);
    } finally {
      server.close();
    }
    await client.flush();

    // Absolute paths and source text stay on the customer's machine; only
    // the resolved `file:fn` frame inside the fingerprint key ships.
    const wire = JSON.stringify(uploads[0]);
    expect(wire).not.toContain("stackTrace");
    expect(wire).not.toContain("kaboom 42\n    at ");
  });

  it("bare http: a throwing handler still produces a log", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessHttp("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const listener = client.setup(() => ({ apiKey: "k" }))(() => {
      crashInHandler();
    });

    // No error-handling layer exists here: res.end never runs, so this is
    // the only chance to log the crash.
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);

    const server = http.createServer(listener);
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      await fetch(`http://127.0.0.1:${port}/boom`, {
        signal: AbortSignal.timeout(300),
      }).catch(() => {
        /* the handler never responded - expected */
      });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      server.close();
      process.off("unhandledRejection", onRejection);
    }
    await client.flush();

    expect(uploads).toHaveLength(1);
    expect(uploads[0].errorFingerprint.strategy).toBe("stack");
    expect(uploads[0].errorFingerprint.key).toContain("crashInHandler");
    // Still an unhandled rejection, exactly as before the fix: we add a
    // log, we don't change the outcome.
    expect((rejections[0] as Error)?.message).toBe("kaboom 42");
  });

  it("koa: records the crash, then re-throws the same error object", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessKoa("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = client.setup(() => ({ apiKey: "k" }));

    const resHeaders: Record<string, string> = {};
    const ctx: any = {
      protocol: "http",
      host: "localhost",
      originalUrl: "/boom",
      url: "/boom",
      method: "GET",
      status: 200,
      body: undefined,
      request: { headers: { host: "localhost" }, body: undefined },
      response: { headers: resHeaders },
      set: (k: string, v: string) => {
        resHeaders[k] = v;
      },
    };

    const thrown = new Error("kaboom 42");
    await expect(
      mw(ctx, async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);

    await client.flush();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].request.log.entries[0].response.status).toBe(500);
    expect(uploads[0].errorFingerprint.strategy).toBe("stack");
  });

  it("koa: an http-errors style status on the thrown error is honoured", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessKoa("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = client.setup(() => ({}));
    const ctx: any = {
      protocol: "http",
      host: "localhost",
      url: "/x",
      method: "GET",
      status: 200,
      request: { headers: {}, body: undefined },
      response: { headers: {} },
      set: () => {},
    };

    const err: any = new Error("nope");
    err.status = 403;
    await expect(
      mw(ctx, async () => {
        throw err;
      }),
    ).rejects.toBe(err);

    await client.flush();
    expect(uploads[0].request.log.entries[0].response.status).toBe(403);
    // 4xx with a stack is not the stack strategy's business (it fires on
    // 5xx only), so this falls through the ladder as usual.
    expect(uploads[0].errorFingerprint.strategy).not.toBe("stack");
  });

  it("hono: records and re-throws when the error propagates", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessHono("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = client.setup(() => ({ apiKey: "k" }));

    const c: any = {
      req: { raw: new Request("http://localhost/boom"), routePath: "/boom" },
      res: new Response("", { status: 200 }),
      header: () => {},
    };
    const thrown = new Error("kaboom 42");
    await expect(
      mw(c, async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);

    await client.flush();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].errorFingerprint.strategy).toBe("stack");
  });

  it("hono: reads c.error when compose already routed it to app.onError", async () => {
    // Hono catches a downstream throw itself, hands it to app.onError and
    // stashes it on the context - `await next()` resolves normally and
    // c.res is already the 500. The stack is still reachable, via c.error.
    const { uploads, fetchImpl } = collector();
    const client = restlessHono("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = client.setup(() => ({ apiKey: "k" }));

    let caught: unknown;
    try {
      crashInHandler();
    } catch (err) {
      caught = err;
    }
    const c: any = {
      req: { raw: new Request("http://localhost/boom"), routePath: "/boom" },
      res: new Response('{"error":"Internal Server Error"}', {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      error: caught,
      header: () => {},
    };
    await mw(c, async () => {});

    await client.flush();
    expect(uploads[0].errorFingerprint.strategy).toBe("stack");
    expect(uploads[0].errorFingerprint.key).toContain("crashInHandler");
  });

  it("fastify: the onError hook feeds the stack into onSend", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restless("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const plugin = client.setup(() => ({ apiKey: "k" }));

    const hooks: Record<string, Function[]> = {};
    const app = {
      addHook(name: string, fn: Function) {
        (hooks[name] ||= []).push(fn);
      },
      decorateRequest() {},
    };
    await (plugin as any)(app);
    expect(hooks.onError).toHaveLength(1);

    const req: any = {
      headers: { host: "localhost" },
      raw: { socket: {}, method: "GET", url: "/boom" },
      url: "/boom",
    };
    const resHeaders: Record<string, string> = { "content-type": "application/json" };
    const reply: any = {
      statusCode: 500,
      header: (k: string, v: string) => {
        resHeaders[k] = v;
        return reply;
      },
      getHeaders: () => resHeaders,
      code: () => reply,
    };

    let caught: unknown;
    try {
      crashInHandler();
    } catch (err) {
      caught = err;
    }

    for (const h of hooks.onRequest!) await h(req, reply);
    for (const h of hooks.preHandler!) await h(req, reply);
    for (const h of hooks.onError!) await h(req, reply, caught);
    for (const h of hooks.onSend!)
      await h(req, reply, '{"error":"Internal Server Error"}');

    await client.flush();
    expect(uploads[0].errorFingerprint.strategy).toBe("stack");
    expect(uploads[0].errorFingerprint.key).toContain("crashInHandler");
  });

  it("next: records the crash, then re-throws the same error object", async () => {
    const { uploads, fetchImpl } = collector();
    const client = restlessNext("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const wrap = client.setup(() => ({ apiKey: "k" }));
    const thrown = new Error("kaboom 42");
    const handler = wrap(async () => {
      throw thrown;
    });

    await expect(handler(new Request("http://localhost/boom"))).rejects.toBe(
      thrown,
    );

    await client.flush();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].request.log.entries[0].response.status).toBe(500);
    expect(uploads[0].errorFingerprint.strategy).toBe("stack");
  });

  it("next: redirect() / notFound() are control flow, not crashes", async () => {
    // Next throws to implement these. Recording them would invent a 500
    // that never happened and put it in front of the customer.
    const { uploads, fetchImpl } = collector();
    const client = restlessNext("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const wrap = client.setup(() => ({}));

    const redirect: any = new Error("NEXT_REDIRECT");
    redirect.digest = "NEXT_REDIRECT;replace;/login;307;";
    const handler = wrap(async () => {
      throw redirect;
    });

    await expect(handler(new Request("http://localhost/private"))).rejects.toBe(
      redirect,
    );

    await client.flush();
    expect(uploads).toHaveLength(0);
  });

  it("a non-Error throw still logs, falling back down the ladder", async () => {
    // Strings and plain objects carry no stack. That must degrade, not
    // crash the capture path.
    const { uploads, fetchImpl } = collector();
    const client = restlessKoa("rdme_test", {
      baseUrl: "http://localhost:3003",
      fetch: fetchImpl,
    });
    const mw = client.setup(() => ({}));
    const ctx: any = {
      protocol: "http",
      host: "localhost",
      url: "/x",
      method: "GET",
      status: 200,
      request: { headers: {}, body: undefined },
      response: { headers: {} },
      set: () => {},
    };

    await expect(
      mw(ctx, async () => {
        throw "just a string";
      }),
    ).rejects.toBe("just a string");

    await client.flush();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].errorFingerprint.strategy).toBe("route-only");
  });
});
