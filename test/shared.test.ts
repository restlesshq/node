import { describe, it, expect } from "vitest";
import {
  buildDebugInjection,
  applyInternalBodyMods,
  resolveBlock,
  requestIdResponseHeaders,
  isSetupHandle,
} from "../src/adapters/_shared.js";

describe("buildDebugInjection", () => {
  it("returns empty headers / no mutator on 2xx", () => {
    const d = buildDebugInjection({
      status: 200,
      requestId: "abc",
      baseUrl: "http://x",
    });
    expect(d.headers).toEqual({});
    expect(d.mutateJsonBody).toBeUndefined();
  });

  it("adds x-log-url and x-debug on 4xx", () => {
    const d = buildDebugInjection({
      status: 404,
      requestId: "abc",
      baseUrl: "http://x",
    });
    expect(d.headers["x-log-url"]).toBe("http://x/logs/abc");
    expect(d.headers["x-debug"]).toBe("npx api debug abc");
  });

  it("injects debug into a JSON body on error", () => {
    const d = buildDebugInjection({
      status: 500,
      requestId: "abc",
      baseUrl: "http://x",
    });
    const mutated = d.mutateJsonBody!({ error: "boom" });
    expect(mutated).toMatchObject({
      error: "boom",
      debug: { log: "http://x/logs/abc", cli: "npx api debug abc" },
    });
  });

  it("leaves non-object bodies alone", () => {
    const d = buildDebugInjection({
      status: 500,
      requestId: "abc",
      baseUrl: "http://x",
    });
    expect(d.mutateJsonBody!("a string")).toBe("a string");
    expect(d.mutateJsonBody!([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("always injects a legible dig-in URL on error, even with no hint", () => {
    const d = buildDebugInjection({
      status: 404,
      requestId: "req-abc-123",
      baseUrl: "http://x",
      fingerprint: "404:resource",
      strategy: "resource",
      method: "GET",
      path: "/car/{id}",
    });
    const mutated = d.mutateJsonBody!({ error: "boom" }) as {
      debug: { recovery: string };
    };
    // `/p/<requestId>/<slug>.md` - the slug is the endpoint (reads as docs); the
    // first segment is the request id, for dashboard correlation.
    const m = mutated.debug.recovery.match(/http:\/\/x\/p\/(\S+?)\/(\S+)\.md/);
    expect(m).toBeTruthy();
    expect(m![1]).toBe("req-abc-123"); // the request id, for correlation
    expect(m![2]).toBe("get-car-id"); // legible slug from method+path
  });

  it("uses the `unknown` slug when there's no matched route", () => {
    const d = buildDebugInjection({
      status: 404,
      requestId: "abc",
      baseUrl: "http://x",
      method: "GET",
      // no path (unmatched route / Next)
    });
    const mutated = d.mutateJsonBody!({ error: "boom" }) as {
      debug: { recovery: string };
    };
    expect(mutated.debug.recovery).toMatch(/\/p\/abc\/unknown\.md/);
  });

  it("keeps the authored hint and appends the dig-in URL", () => {
    const d = buildDebugInjection({
      status: 400,
      requestId: "abc",
      baseUrl: "http://x",
      recovery: "Use a valid status.",
      method: "GET",
      path: "/orders",
    });
    const mutated = d.mutateJsonBody!({ error: "boom" }) as {
      debug: { recovery: string };
    };
    expect(mutated.debug.recovery).toContain("Use a valid status.");
    expect(mutated.debug.recovery).toMatch(/\/p\/abc\/get-orders\.md/);
  });
});

describe("applyInternalBodyMods", () => {
  it("passes through without a mutator", () => {
    expect(applyInternalBodyMods("{}", "application/json", undefined)).toBe(
      "{}",
    );
  });

  it("skips non-JSON", () => {
    expect(
      applyInternalBodyMods("hi", "text/plain", () => ({ nope: true })),
    ).toBe("hi");
  });

  it("applies the mutator on JSON", () => {
    const out = applyInternalBodyMods(
      '{"a":1}',
      "application/json",
      (b: any) => ({ ...b, added: true }),
    );
    expect(JSON.parse(out!)).toEqual({ a: 1, added: true });
  });

  it("swallows JSON parse errors", () => {
    const out = applyInternalBodyMods("not json", "application/json", () => ({
      ok: true,
    }));
    expect(out).toBe("not json");
  });
});

describe("requestIdResponseHeaders", () => {
  it("emits x-request-id when the incoming request has none", () => {
    const h = requestIdResponseHeaders("abc", {});
    expect(h["x-request-id"]).toBe("abc");
    expect(h["x-restless-id"]).toBeUndefined();
  });

  it("falls back to x-restless-id when incoming already has x-request-id", () => {
    const h = requestIdResponseHeaders("abc", { "x-request-id": "upstream" });
    expect(h["x-restless-id"]).toBe("abc");
    expect(h["x-request-id"]).toBeUndefined();
  });

  it("honors the prefix on whichever header it emits", () => {
    const noIncoming = requestIdResponseHeaders("abc", {}, "TST");
    expect(noIncoming["x-request-id"]).toBe("TST-abc");

    const withIncoming = requestIdResponseHeaders(
      "abc",
      { "x-request-id": "u" },
      "TST",
    );
    expect(withIncoming["x-restless-id"]).toBe("TST-abc");
  });
});

describe("resolveBlock", () => {
  it("null when block is falsy", () => {
    expect(resolveBlock({})).toBeNull();
    expect(resolveBlock({ block: false })).toBeNull();
  });
  it("defaults to 403 Forbidden", () => {
    expect(resolveBlock({ block: true })).toEqual({
      status: 403,
      message: "Forbidden",
    });
  });
  it("honors custom status + message", () => {
    expect(
      resolveBlock({ block: { status: 429, message: "Rate limited" } }),
    ).toEqual({ status: 429, message: "Rate limited" });
  });
});

describe("isSetupHandle", () => {
  it("detects a real handle", () => {
    expect(isSetupHandle({ __restless: {} as any, __cb: () => ({}) })).toBe(
      true,
    );
  });
  it("rejects random objects", () => {
    expect(isSetupHandle({})).toBe(false);
    expect(isSetupHandle(null)).toBe(false);
    expect(isSetupHandle("string")).toBe(false);
  });
});
