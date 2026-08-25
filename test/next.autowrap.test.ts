import { describe, it, expect, vi, afterEach } from "vitest";
import restlessNext, {
  wrapRouteHandler,
  defineConfig,
  routePatternFromParams,
  type RestlessNextConfig,
} from "../src/adapters/next.js";

/**
 * Runtime tests for the single-config half of the Next adapter:
 * `wrapRouteHandler` (what the withRestless facade calls per method) plus
 * the wrap-factory hardening it leans on (double-wrap mark, build-phase
 * pass-through, streaming/size body guards, null-body statuses).
 */

function mkFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ingested: 1 }),
    text: async () => "",
  });
}

function mkConfig(overrides: Partial<RestlessNextConfig> = {}) {
  const fetchImpl = mkFetch();
  const config = defineConfig({
    apiKey: "rdme_test",
    setup: (req) => ({
      apiKey: "masked-key",
      owner: { id: "ws_123" },
      _path: new URL(req.url).pathname,
    }),
    fetch: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
  return { config, fetchImpl };
}

/** The uploader flushes fire-and-forget; wait for the mock to be hit. */
async function uploadedPayload(fetchImpl: ReturnType<typeof mkFetch>) {
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  const [, init] = fetchImpl.mock.calls[0]!;
  return JSON.parse((init as RequestInit).body as string);
}

afterEach(() => {
  delete process.env.NEXT_PHASE;
});

describe("wrapRouteHandler", () => {
  it("captures the request and uploads with owner from the config setup", async () => {
    const { config, fetchImpl } = mkConfig();
    const handler = async () =>
      Response.json({ ok: true });
    const GET = wrapRouteHandler(handler, config, "GET");

    const res = await GET(new Request("http://localhost/api/hello"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toEqual({ ok: true });

    const payload = await uploadedPayload(fetchImpl);
    expect(payload).toHaveLength(1);
    expect(payload[0].group.id).toBe("ws_123");
    expect(payload[0].apiKey).toBe("masked-key");
    const entry = payload[0].request.log.entries[0];
    expect(entry.request.url).toBe("http://localhost/api/hello");
    expect(entry.response.status).toBe(200);
  });

  it("works zero-config (no restless.config): stamps headers, never throws", async () => {
    // Hermetic: pin the key so the .env walk-up can't find a real one, and
    // stub global fetch so the zero-config client (which has no injected
    // fetch) can't reach real ingress.
    const origKey = process.env.RESTLESS_KEY;
    process.env.RESTLESS_KEY = "rdme_zero_test";
    const globalFetch = mkFetch();
    vi.stubGlobal("fetch", globalFetch);
    try {
      const handler = async () => Response.json({ ok: true });
      const GET = wrapRouteHandler(handler);

      const res = await GET(new Request("http://localhost/api/zero"));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
      if (origKey === undefined) delete process.env.RESTLESS_KEY;
      else process.env.RESTLESS_KEY = origKey;
    }
  });

  it("passes non-function 'handlers' through unchanged", () => {
    expect(wrapRouteHandler(undefined, undefined, "GET")).toBeUndefined();
    const notAFunction = "force-static" as unknown as undefined;
    expect(wrapRouteHandler(notAFunction)).toBe(notAFunction);
  });

  it("blocks the request when the setup callback says so", async () => {
    const { config } = mkConfig({
      setup: () => ({ block: { status: 429, message: "slow down" } }),
    });
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const GET = wrapRouteHandler(handler, config);

    const res = await GET(new Request("http://localhost/api/blocked"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "slow down" });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("double-wrap guard", () => {
  it("returns an already-wrapped handler unchanged (manual + auto migration)", async () => {
    const { config } = mkConfig();
    const client = restlessNext("rdme_test", {
      fetch: mkFetch() as unknown as typeof fetch,
    });
    const manualWrap = client.setup(() => ({ apiKey: "k" }));

    const handler = async () => Response.json({ ok: true });
    const manuallyWrapped = manualWrap(handler);

    // Auto-wrap on top of a manual wrap is a no-op, and vice versa.
    expect(wrapRouteHandler(manuallyWrapped, config)).toBe(manuallyWrapped);
    const autoWrapped = wrapRouteHandler(handler, config);
    expect(manualWrap(autoWrapped)).toBe(autoWrapped);
    expect(wrapRouteHandler(autoWrapped, config)).toBe(autoWrapped);
  });
});

describe("build-phase guard", () => {
  it("passes straight through during next build prerendering", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    const setup = vi.fn(() => ({ apiKey: "k" }));
    const { config, fetchImpl } = mkConfig({ setup });
    const GET = wrapRouteHandler(
      async () => Response.json({ ok: true }),
      config,
    );

    const res = await GET(new Request("http://localhost/api/static"));
    expect(res.status).toBe(200);
    // No capture, no injected headers — nothing baked into static output.
    expect(res.headers.get("x-request-id")).toBeNull();
    expect(setup).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("body-capture guards", () => {
  it("passes SSE responses through without buffering, headers still stamped", async () => {
    const { config, fetchImpl } = mkConfig();
    // An open stream: buffering it would hang the test until timeout.
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const GET = wrapRouteHandler(
      async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
      config,
    );

    const res = await GET(new Request("http://localhost/api/events"));
    expect(res.headers.get("x-request-id")).toBeDefined();
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // The capture still uploaded — just bodyless.
    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].request.log.entries[0].response.content.text).toBe("");

    controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
    controller.close();
    expect(await res.text()).toBe("data: hi\n\n");
  });

  it("skips body capture when content-length exceeds the 1MB cap", async () => {
    const { config, fetchImpl } = mkConfig();
    const GET = wrapRouteHandler(
      async () =>
        new Response("pretend-huge", {
          headers: {
            "content-type": "application/json",
            "content-length": String(5 * 1024 * 1024),
          },
        }),
      config,
    );

    const res = await GET(new Request("http://localhost/api/huge"));
    expect(await res.text()).toBe("pretend-huge");
    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].request.log.entries[0].response.content.text).toBe("");
  });

  it("skips request-body capture past the cap but still calls the handler with it", async () => {
    const { config, fetchImpl } = mkConfig();
    const seen: string[] = [];
    const POST = wrapRouteHandler(async (req: Request) => {
      seen.push(await req.text());
      return Response.json({ ok: true });
    }, config);

    const res = await POST(
      new Request("http://localhost/api/upload", {
        method: "POST",
        headers: { "content-length": String(5 * 1024 * 1024) },
        body: "actual-body",
      }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(["actual-body"]);
    const payload = await uploadedPayload(fetchImpl);
    // -1 is the HAR convention for "body not captured".
    expect(payload[0].request.log.entries[0].request.bodySize).toBe(-1);
    expect(payload[0].request.log.entries[0].request.postData).toBeUndefined();
  });

  it("serves binary responses byte-for-byte and captures them bodyless", async () => {
    const { config, fetchImpl } = mkConfig();
    // PNG magic + bytes that are NOT valid UTF-8: a decode/re-encode
    // round-trip would corrupt them.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const GET = wrapRouteHandler(
      async () =>
        new Response(bytes, { headers: { "content-type": "image/png" } }),
      config,
    );

    const res = await GET(new Request("http://localhost/api/image"));
    expect(res.headers.get("x-request-id")).toBeDefined();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].request.log.entries[0].response.content.text).toBe("");
  });

  it("passes bodies with no declared content-type through untouched", async () => {
    const { config } = mkConfig();
    const bytes = new Uint8Array([0x00, 0xc3, 0x28, 0xff]);
    const GET = wrapRouteHandler(async () => new Response(bytes), config);
    const res = await GET(new Request("http://localhost/api/raw"));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("drops a handler-set content-length when the debug injection grows the body", async () => {
    const { config } = mkConfig();
    const body = JSON.stringify({ error: "nope" });
    const GET = wrapRouteHandler(
      async () =>
        new Response(body, {
          status: 404,
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
          },
        }),
      config,
    );
    const res = await GET(new Request("http://localhost/api/missing"));
    // Stale length would truncate the enlarged body at clients.
    expect(res.headers.get("content-length")).toBeNull();
    const parsed = await res.json();
    expect(parsed.error).toBe("nope");
    expect(parsed.debug.log).toContain("/logs/");
  });

  it("handles null-body statuses (204) without throwing", async () => {
    const { config } = mkConfig();
    const DELETE = wrapRouteHandler(
      async () => new Response(null, { status: 204 }),
      config,
    );
    const res = await DELETE(
      new Request("http://localhost/api/thing", { method: "DELETE" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("x-request-id")).toBeDefined();
  });
});

describe("owner enrichment through wrapRouteHandler", () => {
  it("runs enrich once per owner id and merges it into every upload", async () => {
    const enrich = vi.fn(async (id: string) => ({
      label: `Workspace ${id}`,
      email: "admin@example.com",
    }));
    const { config, fetchImpl } = mkConfig({
      setup: () => ({
        apiKey: "masked-key",
        owner: { id: "ws_7", plan: "pro", enrich },
      }),
    });
    const GET = wrapRouteHandler(
      async () => Response.json({ ok: true }),
      config,
    );

    await GET(new Request("http://localhost/api/a"));
    await GET(new Request("http://localhost/api/b"));

    // Test env flushes each record immediately → one upload per request.
    await vi.waitFor(() =>
      expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledWith("ws_7");

    const payloads = fetchImpl.mock.calls.flatMap(([, init]) =>
      JSON.parse((init as RequestInit).body as string),
    );
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload.group.id).toBe("ws_7");
      // Enriched fields ride on BOTH uploads — the second comes from the
      // engine's value cache, not a re-run of enrich.
      expect(payload.group.label).toBe("Workspace ws_7");
      expect(payload.group.emails).toEqual(["admin@example.com"]);
    }
  });
});

describe("error debug injection still applies through wrapRouteHandler", () => {
  it("injects debug block + x-log-url on 4xx JSON responses", async () => {
    const { config } = mkConfig();
    const GET = wrapRouteHandler(
      async () =>
        Response.json({ error: "nope" }, { status: 404 }),
      config,
    );
    const res = await GET(new Request("http://localhost/api/missing"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-log-url")).toContain("/logs/");
    const body = await res.json();
    expect(body.error).toBe("nope");
    expect(body.debug.log).toContain("/logs/");
    expect(body.debug.recovery).toContain("fetch ");
  });
});

/**
 * The App Router hands a handler no matched-route string, so the adapter
 * rebuilds one from `context.params`. What hangs off it: the 404 split
 * (`404:resource` vs `404:endpoint`, which carry opposite advice), the
 * `routePattern` the dashboard folds traffic onto, and the dig-in slug.
 */
describe("route pattern recovery from context.params", () => {
  it("templates a single param out of the path", () => {
    expect(routePatternFromParams("/api/pets/42", { id: "42" })).toBe(
      "/api/pets/{id}",
    );
  });

  it("templates several params, and only the segments they occupy", () => {
    expect(
      routePatternFromParams("/api/orgs/acme/pets/42", {
        org: "acme",
        id: "42",
      }),
    ).toBe("/api/orgs/{org}/pets/{id}");
  });

  it("returns the path unchanged for a static route", () => {
    expect(routePatternFromParams("/api/health", {})).toBe("/api/health");
  });

  it("collapses a catch-all's segments into one template", () => {
    expect(
      routePatternFromParams("/api/blog/2026/08/hello", {
        slug: ["2026", "08", "hello"],
      }),
    ).toBe("/api/blog/{slug}");
  });

  it("ignores an optional catch-all that matched nothing", () => {
    expect(routePatternFromParams("/api/blog", { slug: [] })).toBe("/api/blog");
    expect(routePatternFromParams("/api/blog", { slug: undefined })).toBe(
      "/api/blog",
    );
  });

  it("matches an encoded segment against the value Next decoded", () => {
    expect(
      routePatternFromParams("/api/pets/mr%20fluffy", { name: "mr fluffy" }),
    ).toBe("/api/pets/{name}");
  });

  it("leaves a malformed escape as a literal segment", () => {
    // decodeURIComponent throws on this; the segment can't be a param value.
    expect(routePatternFromParams("/api/pets/%E0%A4%A", { id: "42" })).toBe(
      "/api/pets/%E0%A4%A",
    );
  });

  it("templates left to right when two params carry the same value", () => {
    expect(
      routePatternFromParams("/api/a/pets/a", { org: "a", id: "a" }),
    ).toBe("/api/{org}/pets/{id}");
  });

  // Known limitation, pinned rather than fixed: params carry no position, so
  // a value equal to another literal segment in the same path is ambiguous
  // and no runtime rule resolves it. Leftmost wins.
  it("templates the leftmost match when a value collides with a literal", () => {
    // Truth is `/api/pets/{id}` (route app/api/pets/[id], a pet id "pets").
    expect(routePatternFromParams("/api/pets/pets", { id: "pets" })).toBe(
      "/api/{id}/pets",
    );
    // The mirror case leftmost gets right: a value equal to a LATER literal.
    expect(
      routePatternFromParams("/api/pets/photos/photos", { id: "photos" }),
    ).toBe("/api/pets/{id}/photos");
  });

  it("does not template a literal segment that merely looks like an id", () => {
    // `42` is the org id here; the trailing `42` is part of the route.
    expect(routePatternFromParams("/api/42/42", { org: "42" })).toBe(
      "/api/{org}/42",
    );
  });

  it("ships the recovered pattern on the upload", async () => {
    const { config, fetchImpl } = mkConfig();
    const GET = wrapRouteHandler(async () => Response.json({ ok: true }), config);

    await GET(new Request("http://localhost/api/pets/42"), {
      params: Promise.resolve({ id: "42" }),
    });

    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].routePattern).toBe("/api/pets/{id}");
  });

  it("groups a 404 on a parameterized route as a missing RESOURCE", async () => {
    const { config, fetchImpl } = mkConfig();
    const GET = wrapRouteHandler(
      async () => Response.json({ error: "no such pet" }, { status: 404 }),
      config,
    );

    const res = await GET(new Request("http://localhost/api/pets/42"), {
      params: Promise.resolve({ id: "42" }),
    });
    expect(res.status).toBe(404);

    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].errorFingerprint.strategy).toBe("resource");
    expect(payload[0].errorFingerprint.key).toBe("404:resource");
    // The dig-in URL now names the operation instead of `unknown.md`.
    expect((await res.json()).debug.recovery).toContain("get-api-pets-id.md");
  });

  it("groups a 404 on a paramless route as an unknown ENDPOINT", async () => {
    const { config, fetchImpl } = mkConfig();
    const GET = wrapRouteHandler(
      async () => Response.json({ error: "nope" }, { status: 404 }),
      config,
    );

    await GET(new Request("http://localhost/api/pets"), {
      params: Promise.resolve({}),
    });

    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].errorFingerprint.strategy).toBe("endpoint");
    expect(payload[0].routePattern).toBe("/api/pets");
  });

  it("reports the concrete path for a paramless route (params key, no value)", async () => {
    // What Next actually hands a route with no dynamic segments.
    const { config, fetchImpl } = mkConfig();
    const GET = wrapRouteHandler(async () => Response.json({ ok: true }), config);

    await GET(new Request("http://localhost/api/health"), {
      params: undefined,
    });

    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].routePattern).toBe("/api/health");
  });

  it("reports no pattern at all when there is no params key to read", async () => {
    const { config, fetchImpl } = mkConfig();
    const GET = wrapRouteHandler(async () => Response.json({ ok: true }), config);

    // No context (the universal-middleware path can call a handler bare):
    // "unknown", which is not the same as "this route has no params".
    await GET(new Request("http://localhost/api/pets/42"));

    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].routePattern).toBeUndefined();
  });

  it("survives a context whose params getter throws", async () => {
    const { config, fetchImpl } = mkConfig();
    const GET = wrapRouteHandler(async () => Response.json({ ok: true }), config);

    const hostile = {
      get params(): never {
        throw new Error("boom");
      },
    };
    const res = await GET(new Request("http://localhost/api/pets/42"), hostile);

    expect(res.status).toBe(200);
    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].routePattern).toBeUndefined();
  });

  it("carries the pattern onto the log when the handler throws", async () => {
    const { config, fetchImpl } = mkConfig();
    const GET = wrapRouteHandler(async () => {
      throw new Error("crashInHandler");
    }, config);

    await expect(
      GET(new Request("http://localhost/api/pets/42"), {
        params: Promise.resolve({ id: "42" }),
      }),
    ).rejects.toThrow("crashInHandler");

    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].routePattern).toBe("/api/pets/{id}");
  });

  it("accepts a plain params object (Next 14 and earlier)", async () => {
    const { config, fetchImpl } = mkConfig();
    const GET = wrapRouteHandler(async () => Response.json({ ok: true }), config);

    await GET(new Request("http://localhost/api/pets/42"), {
      params: { id: "42" },
    });

    const payload = await uploadedPayload(fetchImpl);
    expect(payload[0].routePattern).toBe("/api/pets/{id}");
  });
});
