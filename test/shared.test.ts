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
});

describe("applyInternalBodyMods", () => {
  it("passes through without a mutator", () => {
    expect(applyInternalBodyMods("{}", "application/json", undefined)).toBe("{}");
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
    const out = applyInternalBodyMods(
      "not json",
      "application/json",
      () => ({ ok: true }),
    );
    expect(out).toBe("not json");
  });
});

describe("requestIdResponseHeaders", () => {
  it("always includes x-restless-id", () => {
    const h = requestIdResponseHeaders("abc", {});
    expect(h["x-restless-id"]).toBe("abc");
  });

  it("also sets x-request-id when none is incoming", () => {
    const h = requestIdResponseHeaders("abc", {});
    expect(h["x-request-id"]).toBe("abc");
  });

  it("does NOT set x-request-id when the client already sent one", () => {
    const h = requestIdResponseHeaders("abc", { "x-request-id": "upstream" });
    expect(h["x-request-id"]).toBeUndefined();
    expect(h["x-restless-id"]).toBe("abc");
  });

  it("honors the prefix", () => {
    const h = requestIdResponseHeaders("abc", {}, "TST");
    expect(h["x-restless-id"]).toBe("TST-abc");
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
