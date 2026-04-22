import { describe, it, expect } from "vitest";
import { toHarEntry } from "../src/lib/har.js";

describe("toHarEntry", () => {
  it("converts a CapturedRequest to a HAR 1.2 entry", () => {
    const entry = toHarEntry({
      requestId: "x",
      startedAt: "2026-01-01T00:00:00.000Z",
      request: {
        method: "POST",
        url: "http://host/p?q=1",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      },
      response: {
        status: 201,
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      },
      duration: 42,
    });
    expect(entry.request.method).toBe("POST");
    expect(entry.request.queryString).toEqual([{ name: "q", value: "1" }]);
    expect(entry.request.postData).toEqual({
      mimeType: "application/json",
      text: '{"a":1}',
    });
    expect(entry.response.status).toBe(201);
    expect(entry.response.content.text).toBe('{"ok":true}');
    expect(entry.timings.wait).toBe(42);
  });

  it("omits postData when there is no request body", () => {
    const entry = toHarEntry({
      requestId: "x",
      startedAt: "2026-01-01T00:00:00.000Z",
      request: { method: "GET", url: "http://host/", headers: {} },
      response: { status: 204, headers: {} },
      duration: 0,
    });
    expect(entry.request.postData).toBeUndefined();
  });
});
