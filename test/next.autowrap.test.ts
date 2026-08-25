import { describe, it, expect, vi, afterEach } from "vitest";
import restlessNext, {
  wrapRouteHandler,
  defineConfig,
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
    // The portal origin the SDK builds every injected URL from. Published by
    // the server on the upload response; the SDK never derives it.
    json: async () => ({ ingested: 1, docsUrl: PORTAL }),
    text: async () => "",
  });
}

const PORTAL = "https://acme.restlessdocs.com";

/** One throwaway request so the engine round-trips a batch and caches it. */
async function warmPortalOrigin(
  config: RestlessNextConfig,
  fetchImpl: ReturnType<typeof mkFetch>,
) {
  const warm = wrapRouteHandler(async () => Response.json({ ok: true }), config);
  await warm(new Request("http://localhost/api/warm"));
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
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
    const { config, fetchImpl } = mkConfig();
    await warmPortalOrigin(config, fetchImpl);
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
    const { config, fetchImpl } = mkConfig();
    await warmPortalOrigin(config, fetchImpl);
    const GET = wrapRouteHandler(
      async () =>
        Response.json({ error: "nope" }, { status: 404 }),
      config,
    );
    const res = await GET(new Request("http://localhost/api/missing"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-log-url")).toContain(`${PORTAL}/logs/`);
    const body = await res.json();
    expect(body.error).toBe("nope");
    expect(body.debug.log).toContain(`${PORTAL}/logs/`);
    expect(body.debug.recovery).toContain(`${PORTAL}/p/`);
  });

  it("headers a 2xx without touching its body", async () => {
    const { config, fetchImpl } = mkConfig();
    await warmPortalOrigin(config, fetchImpl);
    const GET = wrapRouteHandler(
      async () => Response.json({ hello: "world" }),
      config,
    );
    const res = await GET(new Request("http://localhost/api/ok"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-log-url")).toContain(`${PORTAL}/logs/`);
    expect(res.headers.get("x-debug")).toContain("npx api debug");
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("emits no log URL before the first upload round-trip", async () => {
    const { config } = mkConfig();
    const GET = wrapRouteHandler(
      async () => Response.json({ error: "nope" }, { status: 404 }),
      config,
    );
    const res = await GET(new Request("http://localhost/api/missing"));
    // Better a missing line than one that 404s: an agent can't tell them
    // apart, and a dead fetch costs it the whole convention.
    expect(res.headers.get("x-log-url")).toBeNull();
    expect(res.headers.get("x-debug")).toContain("npx api debug");
    const body = await res.json();
    expect(body.debug).toBeUndefined();
  });
});
