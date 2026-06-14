import { describe, it, expect } from "vitest";
import { fingerprint } from "../src/lib/fingerprint.js";

describe("fingerprint: 404 handling", () => {
  it("a parameterized 404 keys to the constant `resource` bucket, not the code", () => {
    const fp = fingerprint({
      status: 404,
      method: "GET",
      route: "/car/{id}",
      responseHeaders: { "x-restless-error-code": "not_found" },
      responseBody: { error: "not_found", message: "No matching resource" },
    });
    expect(fp.strategy).toBe("resource");
    expect(fp.key).toBe("404:resource");
  });

  it("treats a concrete id segment as parameterized (resource bucket)", () => {
    const fp = fingerprint({ status: 404, method: "GET", route: "/car/123" });
    expect(fp.strategy).toBe("resource");
    expect(fp.key).toBe("404:resource");
  });

  it("collapses ALL parameterized 404s into one bucket regardless of route/method", () => {
    const car = fingerprint({ status: 404, method: "GET", route: "/car/{id}" });
    const user = fingerprint({
      status: 404,
      method: "DELETE",
      route: "/user/{id}/posts/{postId}",
    });
    expect(car.key).toBe("404:resource");
    expect(user.key).toBe("404:resource");
  });

  it("a 404 with no path parameter keys to the constant `endpoint` bucket", () => {
    const unmatched = fingerprint({
      status: 404,
      method: "GET",
      responseHeaders: { "x-restless-error-code": "not_found" },
    });
    const paramless = fingerprint({
      status: 404,
      method: "GET",
      route: "/users",
    });
    expect(unmatched.strategy).toBe("endpoint");
    expect(unmatched.key).toBe("404:endpoint");
    // A paramless real route and an unknown path share the bucket - both mean
    // "nothing resolves at this path".
    expect(paramless.key).toBe("404:endpoint");
  });

  it("non-404 statuses still group by code (404 handling is scoped)", () => {
    const fp = fingerprint({
      status: 400,
      method: "GET",
      route: "/car/{id}",
      responseHeaders: { "x-restless-error-code": "invalid_param" },
    });
    expect(fp.strategy).toBe("header");
    expect(fp.key).toBe("400:invalid_param");
  });
});
