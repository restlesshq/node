import { describe, it, expect } from "vitest";
import {
  redactValue,
  redactHeaders,
  redactUrl,
  redactBody,
  truncateBody,
} from "../src/lib/redact.js";

describe("redactValue", () => {
  it("shows length + last4 for long values", () => {
    expect(redactValue("sk_1234567890abcdef")).toBe("<REDACTED:19:cdef>");
  });

  it("omits the tail for short values", () => {
    expect(redactValue("1234567")).toBe("<REDACTED:7>");
  });

  it("handles empty", () => {
    expect(redactValue("")).toBe("<REDACTED:0>");
  });

  it("produces a parseable sentinel format", () => {
    const out = redactValue("a-long-enough-bearer-token");
    expect(out).toMatch(/^<REDACTED:\d+(:.{4})?>$/);
  });
});

describe("redactHeaders", () => {
  it("redacts Authorization, Cookie, etc. by default", () => {
    const out = redactHeaders({
      authorization: "Bearer abcdef0123456789",
      cookie: "sid=xyz9999; csrftoken=aaaa",
      "content-type": "application/json",
      host: "example.com",
    });
    expect(out.authorization).toMatch(/^<REDACTED:/);
    expect(out.cookie).toMatch(/^<REDACTED:/);
    expect(out["content-type"]).toBe("application/json");
    expect(out.host).toBe("example.com");
  });

  it("is case-insensitive on the header name", () => {
    const out = redactHeaders({
      Authorization: "Bearer xxxxxxxxxxxx",
      "X-API-KEY": "sk_abcdef0123",
    });
    expect(out.Authorization).toMatch(/^<REDACTED:/);
    expect(out["X-API-KEY"]).toMatch(/^<REDACTED:/);
  });

  it("honors extra denylist entries", () => {
    const out = redactHeaders(
      { "x-custom-secret": "verylongsecretvalue" },
      ["x-custom-secret"],
    );
    expect(out["x-custom-secret"]).toMatch(/^<REDACTED:/);
  });

  it("does not mutate the input", () => {
    const input = { authorization: "Bearer xxxxxxxxxxxx" };
    redactHeaders(input);
    expect(input.authorization).toBe("Bearer xxxxxxxxxxxx");
  });
});

describe("redactUrl", () => {
  it("redacts api_key / token / access_token in query", () => {
    const out = redactUrl(
      "https://api.example/v1/foo?bar=ok&api_key=sk_abcdef123&token=tk_9876543210",
    );
    expect(out).toContain("bar=ok");
    expect(out).toMatch(/api_key=%3CREDACTED/);
    expect(out).toMatch(/token=%3CREDACTED/);
  });

  it("leaves URLs with no sensitive params alone", () => {
    const out = redactUrl("https://api.example/v1/foo?bar=ok");
    expect(out).toBe("https://api.example/v1/foo?bar=ok");
  });

  it("returns non-URLs unchanged", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("redactBody", () => {
  it("redacts sensitive keys in JSON", () => {
    const out = redactBody(
      JSON.stringify({
        username: "jane",
        password: "hunter2hunter2",
        cc_number: "4111111111111111",
      }),
      "application/json",
    );
    const parsed = JSON.parse(out!);
    expect(parsed.username).toBe("jane");
    expect(parsed.password).toMatch(/^<REDACTED:/);
    expect(parsed.cc_number).toMatch(/^<REDACTED:/);
  });

  it("normalizes snake_case vs camelCase vs PascalCase vs kebab-case", () => {
    const out = redactBody(
      JSON.stringify({
        apiKey: "abcdefghijk",
        api_key: "abcdefghijk",
        "API-Key": "abcdefghijk",
        APIKEY: "abcdefghijk",
      }),
      "application/json",
    );
    const parsed = JSON.parse(out!);
    expect(parsed.apiKey).toMatch(/^<REDACTED:/);
    expect(parsed.api_key).toMatch(/^<REDACTED:/);
    expect(parsed["API-Key"]).toMatch(/^<REDACTED:/);
    expect(parsed.APIKEY).toMatch(/^<REDACTED:/);
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactBody(
      JSON.stringify({
        user: { name: "jane", password: "hunter2hunter2" },
        auths: [{ token: "tk_abcdef123" }],
      }),
      "application/json",
    );
    const parsed = JSON.parse(out!);
    expect(parsed.user.name).toBe("jane");
    expect(parsed.user.password).toMatch(/^<REDACTED:/);
    expect(parsed.auths[0].token).toMatch(/^<REDACTED:/);
  });

  it("leaves non-JSON unchanged", () => {
    expect(redactBody("plain text", "text/plain")).toBe("plain text");
  });

  it("passes through unparseable JSON", () => {
    expect(redactBody("{not json", "application/json")).toBe("{not json");
  });

  it("redacts non-string secret values as <REDACTED>", () => {
    const out = redactBody(
      JSON.stringify({ password: 12345, token: null }),
      "application/json",
    );
    const parsed = JSON.parse(out!);
    expect(parsed.password).toBe("<REDACTED>");
    expect(parsed.token).toBe(null);
  });
});

describe("truncateBody", () => {
  it("passes short bodies through", () => {
    expect(truncateBody("short", 100)).toBe("short");
  });

  it("truncates and appends a marker", () => {
    const body = "x".repeat(500);
    const out = truncateBody(body, 100);
    expect(out!.length).toBeLessThan(body.length + 50);
    expect(out).toMatch(/\[\.\.\.TRUNCATED: original \d+ bytes\]$/);
  });

  it("passes undefined through", () => {
    expect(truncateBody(undefined, 100)).toBeUndefined();
  });
});
