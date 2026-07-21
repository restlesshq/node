import { describe, it, expect } from "vitest";
import { toHarEntry, safeStringifyReqBody } from "../src/lib/har.js";

describe("safeStringifyReqBody", () => {
  it("passes strings through untouched", () => {
    expect(safeStringifyReqBody("already a string", "application/json")).toBe(
      "already a string",
    );
  });

  it("returns undefined for a nullish body", () => {
    expect(safeStringifyReqBody(undefined)).toBeUndefined();
    expect(safeStringifyReqBody(null)).toBeUndefined();
  });

  it("serializes plain objects", () => {
    expect(safeStringifyReqBody({ a: 1 }, "application/json")).toBe('{"a":1}');
  });

  it("skips multipart/form-data bodies (a stringified parse is meaningless)", () => {
    expect(
      safeStringifyReqBody(
        { field: "value" },
        "multipart/form-data; boundary=----x",
      ),
    ).toBeUndefined();
  });

  it("drops a circular body to undefined instead of throwing", () => {
    // Mirrors @fastify/multipart with attachFieldsToBody: each file has a
    // .fields back-pointer to its siblings, so the body is circular.
    const file: any = { type: "file", filename: "a.png" };
    const fields: any = { schema: file };
    file.fields = fields;
    expect(() => safeStringifyReqBody(fields, "application/json")).not.toThrow();
    expect(safeStringifyReqBody(fields, "application/json")).toBeUndefined();
  });
});

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
