/**
 * withRestless(nextConfig) — the single-config entry point for Next.js.
 *
 * Runs at next.config evaluation time (Node, both `next dev` and
 * `next build`). Discovers `restless.config.*` at the project root, then
 * injects the wrapping loader (see ./next-loader.ts) into whichever bundler
 * is active: a `module.rules` entry for webpack, a `turbopack.rules` entry
 * for Turbopack. Only the active bundler is patched — Next warns when a
 * custom webpack config exists under Turbopack, so mirroring Sentry's
 * detect-and-patch-one approach keeps builds quiet.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// Type-only: a value import would inline next-loader (and its
// `module.exports = loader` interop footer) into the next.cjs bundle,
// clobbering that bundle's own exports.
import type { RestlessLoaderOptions } from "./next-loader.js";

/** Must stay in sync with ORIGINAL_QUERY in ./next-loader.ts. */
const ORIGINAL_QUERY = "__restless_original__";

const DEFAULT_EXTS = ["tsx", "ts", "jsx", "js"];

const CONFIG_BASENAMES = [
  "restless.config.ts",
  "restless.config.mts",
  "restless.config.cts",
  "restless.config.js",
  "restless.config.mjs",
  "restless.config.cjs",
];

export interface WithRestlessOptions {
  /**
   * Allowlist: when set, ONLY route files matching one of these
   * root-relative posix globs are wrapped, e.g. `["app/api/v1/**"]` to
   * scope capture to a public API subtree. Globs match with or without a
   * leading `src/`. `exclude` still wins on overlap.
   */
  include?: string[];
  /** Root-relative posix globs of route files to leave unwrapped. */
  exclude?: string[];
  /** Override restless.config.* discovery (absolute or root-relative). */
  configPath?: string;
  /** Log every wrapped/skipped file at build time. */
  debug?: boolean;
  /** Kill switch — return the config untouched. */
  disabled?: boolean;
  /** Override the Next project root (defaults to process.cwd()). */
  projectRoot?: string;

  /** @internal — test hook: skip bundler auto-detection. */
  bundler?: "webpack" | "turbopack";
  /** @internal — test hook: skip `next/package.json` version resolution. */
  nextVersion?: string;
}

/**
 * Structural stand-in for Next's config shape — `next` is an optional peer
 * dependency and isn't installed in this repo, so its types can't be
 * imported. Object, function, and async-function config forms all work.
 */
interface NextConfigLike {
  pageExtensions?: string[];
  webpack?: ((config: any, context: any) => any) | null;
  turbopack?: { rules?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

let warnedNoConfig = false;
let warnedOldTurbopack = false;

function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function versionAtLeast(v: string, min: string): boolean {
  const [a, b, c] = parseVersion(v);
  const [x, y, z] = parseVersion(min);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
}

function resolveNextVersion(root: string): string | undefined {
  try {
    const req = createRequire(path.join(root, "package.json"));
    return (req("next/package.json") as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Which bundler is this process using? Mirrors Sentry's detection: Next
 * sets TURBOPACK in the env when Turbopack is active; explicit CLI flags
 * win; otherwise fall back to the version default (Turbopack since 16).
 */
function detectBundler(nextVersion?: string): "webpack" | "turbopack" {
  if (process.argv.includes("--webpack")) return "webpack";
  const t = process.env.TURBOPACK;
  if (t && t !== "false" && t !== "0") return "turbopack";
  if (process.argv.includes("--turbo") || process.argv.includes("--turbopack"))
    return "turbopack";
  if (nextVersion && versionAtLeast(nextVersion, "16.0.0")) return "turbopack";
  return "webpack";
}

function resolveConfigPath(
  root: string,
  explicit?: string,
): string | undefined {
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(root, explicit);
  }
  for (const basename of CONFIG_BASENAMES) {
    const candidate = path.join(root, basename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Absolute path of the loader artifact. Sits next to this module in dist/
 * (webpack require()s loaders by path; the same path works as a Turbopack
 * rule loader). The .ts fallback covers running from source under vitest.
 */
function resolveLoaderPath(): string {
  for (const rel of ["./next-loader.cjs", "./next-loader.ts"]) {
    try {
      const candidate = fileURLToPath(new URL(rel, import.meta.url));
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return "@restlessai/sdk/next-loader";
}

function routeFileRegex(exts: string[]): RegExp {
  const alt = exts.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(
    `[\\\\/](?:src[\\\\/])?app[\\\\/](?:.*[\\\\/])?route\\.(?:${alt})$`,
  );
}

function apply<C extends NextConfigLike>(
  cfg: C,
  options: WithRestlessOptions,
): C {
  const root = path.resolve(options.projectRoot ?? process.cwd());
  const configPath = resolveConfigPath(root, options.configPath);
  if (!configPath && !warnedNoConfig) {
    warnedNoConfig = true;
    console.warn(
      "[@restlessai/sdk] no restless.config.{ts,js,...} found at the project root — " +
        "auto-wrap runs in zero-config mode (RESTLESS_KEY from env, anonymous capture). " +
        "Create restless.config.ts with defineConfig({ setup }) to attribute requests to owners.",
    );
  }

  const exts = cfg.pageExtensions?.length ? cfg.pageExtensions : DEFAULT_EXTS;
  // No undefined values: Turbopack requires loader options to be strictly
  // serializable and rejects objects with undefined-valued keys.
  const loaderOptions: RestlessLoaderOptions = { projectRoot: root, exts };
  if (configPath) loaderOptions.configPath = configPath;
  if (options.include?.length) loaderOptions.include = options.include;
  if (options.exclude?.length) loaderOptions.exclude = options.exclude;
  if (options.debug) loaderOptions.debug = options.debug;
  const loaderPath = resolveLoaderPath();
  const nextVersion = options.nextVersion ?? resolveNextVersion(root);
  const bundler = options.bundler ?? detectBundler(nextVersion);

  const out: NextConfigLike = { ...cfg };

  if (bundler === "webpack") {
    const userWebpack = cfg.webpack;
    out.webpack = (wpConfig: any, ctx: any) => {
      // `?? wpConfig` covers user fns that mutate the config in place and
      // return nothing — non-idiomatic but a real pattern.
      const base =
        (typeof userWebpack === "function"
          ? userWebpack(wpConfig, ctx)
          : wpConfig) ?? wpConfig;
      base.module ??= {};
      base.module.rules ??= [];
      // `enforce: 'pre'` so the loader sees the original TS/JS source —
      // the same input Turbopack rules get — keeping detection identical
      // across bundlers. The facade then flows through SWC normally.
      base.module.rules.unshift({
        test: routeFileRegex(exts),
        enforce: "pre",
        resourceQuery: { not: [new RegExp(ORIGINAL_QUERY)] },
        use: [{ loader: loaderPath, options: loaderOptions }],
      });
      return base;
    };
    return out as C;
  }

  // Turbopack. `turbopack.rules` shipped in 15.3.
  if (nextVersion && !versionAtLeast(nextVersion, "15.3.0")) {
    if (!warnedOldTurbopack) {
      warnedOldTurbopack = true;
      console.warn(
        `[@restlessai/sdk] Turbopack auto-wrap needs Next >= 15.3 (found ${nextVersion}) — ` +
          "routes are NOT being captured. Upgrade Next, build with --webpack, or wrap routes manually (see install.md).",
      );
    }
    return out as C;
  }

  // `**/`-prefixed on purpose: Turbopack resolves rule globs against its
  // lockfile-detected root (the monorepo root, not the app dir). The
  // loader's own projectRoot check does the precise scoping.
  const glob = `**/app/**/route.{${exts.join(",")}}`;
  const rule: Record<string, unknown> = {
    loaders: [{ loader: loaderPath, options: loaderOptions as never }],
  };
  // Rule conditions exist since 16.0; `foreign` skips node_modules and
  // Next internals. On 15.x the loader's path checks stand alone.
  if (!nextVersion || versionAtLeast(nextVersion, "16.0.0")) {
    rule.condition = { not: "foreign" };
  }
  out.turbopack = {
    ...cfg.turbopack,
    rules: { [glob]: rule, ...cfg.turbopack?.rules },
  };
  return out as C;
}

/**
 * Wrap a Next config with Restless auto-instrumentation. Composes with
 * object, function, and async-function config forms:
 *
 *     export default withRestless(nextConfig);
 *     export default withRestless(async (phase, ctx) => ({ ... }));
 */
export function withRestless<C>(
  nextConfig?: C,
  options: WithRestlessOptions = {},
): C {
  if (options.disabled) return (nextConfig ?? {}) as C;

  if (typeof nextConfig === "function") {
    return ((...args: unknown[]) => {
      const result = (nextConfig as (...a: unknown[]) => unknown)(...args);
      if (
        result &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        return (result as PromiseLike<NextConfigLike>).then((resolved) =>
          apply(resolved ?? {}, options),
        );
      }
      return apply((result as NextConfigLike) ?? {}, options);
    }) as C;
  }

  return apply((nextConfig as NextConfigLike) ?? {}, options) as C;
}
