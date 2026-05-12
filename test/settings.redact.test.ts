import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import restless from "../src/index.js";
import { _resetSettingsCache, resolveApi } from "../src/lib/settings.js";

function makeSettingsDir(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "restless-redact-"));
  const api = join(dir, ".restless");
  mkdirSync(api);
  writeFileSync(join(api, "settings.json"), JSON.stringify(contents));
  return dir;
}

describe("resolveApi — redact settings", () => {
  it("returns the redact block from the settings entry", () => {
    const picked = resolveApi({
      version: 1,
      apis: [
        {
          id: "a1",
          name: "Solo",
          redact: {
            headers: ["x-auth"],
            bodyKeys: ["sshKey"],
            queryParams: ["signed"],
          },
        },
      ],
    });
    expect(picked?.redact).toEqual({
      headers: ["x-auth"],
      bodyKeys: ["sshKey"],
      queryParams: ["signed"],
    });
  });

  it("returns undefined redact when the entry has none", () => {
    const picked = resolveApi({
      version: 1,
      apis: [{ id: "a1", name: "Solo" }],
    });
    expect(picked?.redact).toBeUndefined();
  });
});

describe("restless() — redact merge from settings + opts", () => {
  beforeEach(() => _resetSettingsCache());

  it("end-to-end: settings-sourced redact is applied to captured requests", async () => {
    const dir = makeSettingsDir({
      version: 1,
      apis: [
        {
          id: "a1",
          name: "Test",
          redact: { headers: ["x-company-auth"] },
        },
      ],
    });
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      let sent: any;
      const fetchImpl = vi.fn().mockImplementation(async (_url, init: any) => {
        sent = JSON.parse(init.body);
        return { ok: true, text: async () => "" };
      });
      const client = restless("k", { fetch: fetchImpl as unknown as typeof fetch });
      client.engine.record({
        requestId: "r1",
        startedAt: new Date().toISOString(),
        request: {
          method: "GET",
          url: "http://x/",
          headers: { "x-company-auth": "super-secret-token-xyz9" },
        },
        response: { status: 200, headers: {} },
        duration: 1,
      });
      await client.flush();
      const entry = sent[0].request.log.entries[0];
      const h = entry.request.headers.find(
        (x: any) => x.name === "x-company-auth",
      );
      expect(h.value).toMatch(/^<REDACTED:/);
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settings redact and opts.redact are BOTH merged on top of defaults", async () => {
    const dir = makeSettingsDir({
      version: 1,
      apis: [
        {
          id: "a1",
          name: "Test",
          redact: { headers: ["x-from-settings"] },
        },
      ],
    });
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      let sent: any;
      const fetchImpl = vi.fn().mockImplementation(async (_url, init: any) => {
        sent = JSON.parse(init.body);
        return { ok: true, text: async () => "" };
      });
      const client = restless("k", {
        redact: { headers: ["x-from-opts"] },
        fetch: fetchImpl as unknown as typeof fetch,
      });
      // Force flush because default baseUrl is HTTPS prod, not localhost
      client.engine.record({
        requestId: "r1",
        startedAt: new Date().toISOString(),
        request: {
          method: "GET",
          url: "http://x/",
          headers: {
            "x-from-settings": "value-from-settings-9999",
            "x-from-opts": "value-from-opts-0000",
            authorization: "Bearer default-redacted-abcd",
            "x-untouched": "plain-value",
          },
        },
        response: { status: 200, headers: {} },
        duration: 1,
      });
      await client.flush();
      const entry = sent[0].request.log.entries[0];
      const byName = (n: string) =>
        entry.request.headers.find((h: any) => h.name === n).value;

      expect(byName("x-from-settings")).toMatch(/^<REDACTED:/);
      expect(byName("x-from-opts")).toMatch(/^<REDACTED:/);
      expect(byName("authorization")).toMatch(/^<REDACTED:/); // built-in default
      expect(byName("x-untouched")).toBe("plain-value");
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
