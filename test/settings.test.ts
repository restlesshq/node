import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSettings,
  resolveApi,
  _resetSettingsCache,
} from "../src/lib/settings.js";

function makeSettingsDir(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "restless-settings-"));
  const api = join(dir, ".restless");
  mkdirSync(api);
  writeFileSync(join(api, "settings.json"), JSON.stringify(contents));
  return dir;
}

describe("settings loader", () => {
  beforeEach(() => _resetSettingsCache());

  it("walks up to find .restless/settings.json", () => {
    const dir = makeSettingsDir({
      version: 1,
      apis: [{ id: "abc", name: "Test" }],
    });
    try {
      const nested = join(dir, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      const s = loadSettings(nested);
      expect(s?.apis[0]?.name).toBe("Test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no file exists", () => {
    const s = loadSettings("/tmp/definitely-does-not-exist-asdf1234");
    expect(s).toBeNull();
  });
});

describe("resolveApi", () => {
  it("picks the one API when only one exists", () => {
    const picked = resolveApi({
      version: 1,
      apis: [{ id: "a1", name: "Solo", requestIdPrefix: "SOL" }],
    });
    expect(picked).toEqual({ id: "a1", name: "Solo", requestIdPrefix: "SOL" });
  });

  it("picks by name when multiple exist", () => {
    const picked = resolveApi(
      {
        version: 1,
        apis: [
          { id: "a1", name: "Public" },
          { id: "a2", name: "Internal" },
        ],
      },
      "Internal",
    );
    expect(picked?.id).toBe("a2");
  });

  it("also matches by id", () => {
    const picked = resolveApi(
      {
        version: 1,
        apis: [{ id: "abc", name: "Test" }],
      },
      "abc",
    );
    expect(picked?.name).toBe("Test");
  });

  it("throws on ambiguous multi-API settings without a name", () => {
    expect(() =>
      resolveApi({
        version: 1,
        apis: [
          { id: "a1", name: "Public" },
          { id: "a2", name: "Internal" },
        ],
      }),
    ).toThrow(/multiple APIs/);
  });

  it("throws on missing name match", () => {
    expect(() =>
      resolveApi(
        {
          version: 1,
          apis: [{ id: "a1", name: "Public" }],
        },
        "Unknown",
      ),
    ).toThrow(/no API named "Unknown"/);
  });

  it("returns null for empty settings", () => {
    expect(resolveApi(null)).toBeNull();
    expect(resolveApi({ version: 1, apis: [] })).toBeNull();
  });
});
