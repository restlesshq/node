import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withRestless } from "../src/adapters/next-plugin.js";

/**
 * Config-transform tests for withRestless. Bundler and Next version are
 * pinned via the internal test hooks so nothing depends on this process's
 * env or the repo's node_modules.
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "restless-plugin-"));
  fs.writeFileSync(path.join(root, "restless.config.ts"), "export default {}\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function opts(overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: root,
    bundler: "webpack" as const,
    nextVersion: "16.1.0",
    ...overrides,
  };
}

/** Run the injected webpack fn against a minimal webpack config. */
function runWebpack(cfg: { webpack?: (c: any, ctx: any) => any }) {
  const wpConfig: any = { module: { rules: [] } };
  return cfg.webpack!(wpConfig, { isServer: true });
}

describe("webpack injection", () => {
  it("unshifts a pre-loader rule scoped to route files", () => {
    const out = withRestless({}, opts());
    const wp = runWebpack(out);
    expect(wp.module.rules).toHaveLength(1);
    const rule = wp.module.rules[0];
    expect(rule.enforce).toBe("pre");
    expect(rule.resourceQuery.not[0].test("?__restless_original__")).toBe(true);
    expect(rule.use[0].loader).toMatch(/next-loader\.(cjs|ts)$/);
    expect(rule.use[0].options.projectRoot).toBe(root);
    expect(rule.use[0].options.configPath).toBe(
      path.join(root, "restless.config.ts"),
    );

    // The test regex matches route files in app/ and src/app, at any depth.
    for (const p of [
      "/proj/app/route.ts",
      "/proj/app/api/hello/route.ts",
      "/proj/src/app/api/(group)/[id]/route.tsx",
      "C:\\proj\\src\\app\\api\\route.js",
    ]) {
      expect(rule.test.test(p), p).toBe(true);
    }
    for (const p of [
      "/proj/app/api/handlers.ts",
      "/proj/pages/api/route.ts",
      "/proj/my-app/route.ts",
      "/proj/app/api/route.css",
    ]) {
      expect(rule.test.test(p), p).toBe(false);
    }
  });

  it("preserves the user's webpack function and runs it first", () => {
    const order: string[] = [];
    const userCfg = {
      webpack: (c: any) => {
        order.push("user");
        c.module.rules.push({ marker: "user-rule" });
        return c;
      },
    };
    const out = withRestless(userCfg, opts());
    const wp = runWebpack(out);
    expect(wp.module.rules.map((r: any) => r.marker ?? "restless")).toEqual([
      "restless",
      "user-rule",
    ]);
    expect(order).toEqual(["user"]);
  });

  it("tolerates user webpack fns that mutate in place and return undefined", () => {
    const userCfg = {
      webpack: (c: any) => {
        c.module.rules.push({ marker: "user-rule" });
        // no return — mutate-in-place pattern
      },
    };
    const out = withRestless(userCfg, opts());
    const wp = runWebpack(out);
    expect(wp.module.rules.map((r: any) => r.marker ?? "restless")).toEqual([
      "restless",
      "user-rule",
    ]);
  });

  it("propagates custom pageExtensions into the rule and loader options", () => {
    const out = withRestless({ pageExtensions: ["mts", "ts"] }, opts());
    const wp = runWebpack(out);
    const rule = wp.module.rules[0];
    expect(rule.test.test("/p/app/route.mts")).toBe(true);
    expect(rule.test.test("/p/app/route.tsx")).toBe(false);
    expect(rule.use[0].options.exts).toEqual(["mts", "ts"]);
  });
});

describe("turbopack injection", () => {
  it("adds a **/-prefixed rule with the loader and JSON-safe options", () => {
    const out = withRestless<any>({}, opts({ bundler: "turbopack" }));
    const rules = out.turbopack.rules;
    const key = "**/app/**/route.{tsx,ts,jsx,js}";
    expect(Object.keys(rules)).toEqual([key]);
    const rule = rules[key];
    expect(rule.condition).toEqual({ not: "foreign" });
    expect(rule.loaders[0].loader).toMatch(/next-loader\.(cjs|ts)$/);
    // Turbopack JSON-serializes loader options — no RegExp/function values.
    expect(JSON.parse(JSON.stringify(rule.loaders[0].options))).toEqual(
      rule.loaders[0].options,
    );
    // No webpack patch under turbopack (Next warns on stray webpack config).
    expect(out.webpack).toBeUndefined();
  });

  it("preserves existing turbopack rules and config", () => {
    const userTurbo = {
      root: "/mono",
      rules: { "*.svg": { loaders: ["@svgr/webpack"] } },
    };
    const out = withRestless<any>(
      { turbopack: userTurbo },
      opts({ bundler: "turbopack" }),
    );
    expect(out.turbopack.root).toBe("/mono");
    expect(out.turbopack.rules["*.svg"]).toEqual(userTurbo.rules["*.svg"]);
    expect(
      out.turbopack.rules["**/app/**/route.{tsx,ts,jsx,js}"],
    ).toBeDefined();
  });

  it("omits rule.condition below Next 16 (conditions shipped in 16.0)", () => {
    const out = withRestless<any>(
      {},
      opts({ bundler: "turbopack", nextVersion: "15.4.1" }),
    );
    const rule = out.turbopack.rules["**/app/**/route.{tsx,ts,jsx,js}"];
    expect(rule.condition).toBeUndefined();
    expect(rule.loaders).toHaveLength(1);
  });

  it("warns and injects nothing on Turbopack below 15.3", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = withRestless<any>(
      {},
      opts({ bundler: "turbopack", nextVersion: "15.2.0" }),
    );
    expect(out.turbopack).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("needs Next >= 15.3"),
    );
  });
});

describe("bundler detection", () => {
  it("TURBOPACK env selects the turbopack patch", () => {
    vi.stubEnv("TURBOPACK", "1");
    try {
      const out = withRestless<any>(
        {},
        { projectRoot: root, nextVersion: "16.1.0" },
      );
      expect(out.turbopack).toBeDefined();
      expect(out.webpack).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("defaults by version when env and argv say nothing", () => {
    vi.stubEnv("TURBOPACK", "");
    try {
      const v15 = withRestless<any>(
        {},
        { projectRoot: root, nextVersion: "15.5.0" },
      );
      expect(v15.webpack).toBeDefined();
      const v16 = withRestless<any>(
        {},
        { projectRoot: root, nextVersion: "16.0.0" },
      );
      expect(v16.turbopack).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("config forms and discovery", () => {
  it("composes with function-form next configs", () => {
    const fnConfig = (phase: string) => ({ env: { PHASE: phase } });
    const wrapped = withRestless(fnConfig as any, opts()) as any;
    const result = wrapped("phase-test", {});
    expect(result.env.PHASE).toBe("phase-test");
    expect(result.webpack).toBeDefined();
  });

  it("composes with async function-form next configs", async () => {
    const fnConfig = async () => ({ reactStrictMode: true });
    const wrapped = withRestless(fnConfig as any, opts()) as any;
    const result = await wrapped("phase-test", {});
    expect(result.reactStrictMode).toBe(true);
    expect(result.webpack).toBeDefined();
  });

  it("discovers restless.config by precedence and honors configPath override", () => {
    fs.writeFileSync(path.join(root, "restless.config.js"), "module.exports = {}\n");
    // .ts wins over .js.
    const out = withRestless({}, opts());
    expect(runWebpack(out).module.rules[0].use[0].options.configPath).toBe(
      path.join(root, "restless.config.ts"),
    );
    // Explicit override, root-relative.
    const explicit = withRestless(
      {},
      opts({ configPath: "config/restless.ts" }),
    );
    expect(
      runWebpack(explicit).module.rules[0].use[0].options.configPath,
    ).toBe(path.join(root, "config/restless.ts"));
  });

  it("warns once (zero-config) when no config file exists", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.rmSync(path.join(root, "restless.config.ts"));
    const out = withRestless({}, opts());
    expect(
      runWebpack(out).module.rules[0].use[0].options.configPath,
    ).toBeUndefined();
    withRestless({}, opts());
    const zeroConfigWarns = warn.mock.calls.filter(([msg]) =>
      String(msg).includes("zero-config"),
    );
    expect(zeroConfigWarns).toHaveLength(1);
  });

  it("disabled returns the config untouched", () => {
    const cfg = { reactStrictMode: true };
    const out = withRestless(cfg, { ...opts(), disabled: true });
    expect(out).toBe(cfg);
    expect((out as any).webpack).toBeUndefined();
  });

  it("include and exclude globs flow through to loader options", () => {
    const out = withRestless(
      {},
      opts({ include: ["app/api/v1/**"], exclude: ["app/api/health/**"] }),
    );
    const loaderOpts = runWebpack(out).module.rules[0].use[0].options;
    expect(loaderOpts.include).toEqual(["app/api/v1/**"]);
    expect(loaderOpts.exclude).toEqual(["app/api/health/**"]);
    // Absent lists are omitted entirely (Turbopack serialization).
    const bare = withRestless({}, opts());
    const bareOpts = runWebpack(bare).module.rules[0].use[0].options;
    expect("include" in bareOpts).toBe(false);
    expect("exclude" in bareOpts).toBe(false);
  });
});
