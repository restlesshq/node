import { createHash } from "node:crypto";

/**
 * Sampling: per-endpoint control over how much of each request is sent.
 * Normative spec: CONTRACT.md section 12.1 (`SAMPLE`).
 *
 * Everything here is pure. The runtime rolls `u` (`Math.random()`) once per
 * request and feeds it to `decide`; tests and the conformance driver feed a
 * fixed one.
 */

/**
 * `"on"` sends every request in full, `"off"` sends nothing, `"errors"`
 * sends only status >= 400. A number in [0, 1] sends that fraction of
 * successful requests in full and the rest as bodyless stubs; errors are
 * always sent in full.
 */
export type SamplingMode = "on" | "off" | "errors" | number;

/** The shape accepted in code and in `.restless/settings.json`. */
export interface SamplingConfig {
  default?: SamplingMode;
  /** Keyed by `"<METHOD> <route>"`, e.g. `"GET /pets/{id}"` or `"* /health"`. */
  routes?: Record<string, SamplingMode>;
}

/** A validated, merged config. Rates are already quantized (SAMPLE-002). */
export interface NormalizedSampling {
  default: SamplingMode;
  routes: Map<string, SamplingMode>;
}

export type SamplingOutcome = "full" | "stub" | "drop";

/** Rates are quantized to this many steps (SAMPLE-002). */
const RATE_STEPS = 10000;

// SAMPLE-010. Printable ASCII only, so every SDK sorts and hashes keys
// byte-for-byte the same without depending on its JSON encoder or string
// model.
const PATH_RE = /^\/[\x21-\x7e]*$/;
const METHOD_RE = /^(?:[A-Za-z]+|\*)$/;
// SAMPLE-011. Same substitution the Express and Fastify adapters apply to
// their own patterns; Koa and Hono hand over `:param` untouched.
const PARAM_RE = /:([A-Za-z0-9_]+)/g;

/**
 * SAMPLE-001..003. Returns the normalized mode, or `undefined` when the
 * value is not a valid mode (the caller decides what invalid falls back to).
 */
export function normalizeMode(value: unknown): SamplingMode | undefined {
  if (value === "on" || value === "off" || value === "errors") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  const steps = Math.floor(value * RATE_STEPS + 0.5);
  // A rate that rounds to 1 IS "on"; keep one spelling of it so the
  // dashboard and the hash never see two.
  return steps >= RATE_STEPS ? "on" : steps / RATE_STEPS;
}

/** SAMPLE-011. Normalize a route pattern for matching. */
export function normalizePath(path: string): string | undefined {
  let p = path.replace(PARAM_RE, "{$1}");
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return PATH_RE.test(p) ? p : undefined;
}

/** SAMPLE-010. `"get  /pets/:id/"` becomes `"GET /pets/{id}"`. */
export function normalizeRouteKey(key: string): string | undefined {
  const trimmed = key.replace(/^ +| +$/g, "");
  const space = trimmed.indexOf(" ");
  if (space === -1) return undefined;
  const method = trimmed.slice(0, space);
  const path = normalizePath(trimmed.slice(space).replace(/^ +/, ""));
  if (!METHOD_RE.test(method) || path === undefined) return undefined;
  return `${asciiUpper(method)} ${path}`;
}

/**
 * SAMPLE-013, SAMPLE-014. Merge the settings-file and code configs and
 * validate every value. Never throws: bad input degrades to `"on"` (or is
 * ignored, for a bad key) and is reported in `warnings` for the debug log.
 */
export function normalizeSampling(
  settings?: unknown,
  code?: unknown,
): { config: NormalizedSampling; warnings: string[] } {
  const warnings: string[] = [];
  const config: NormalizedSampling = { default: "on", routes: new Map() };

  for (const [source, raw] of [
    ["settings", settings],
    ["code", code],
  ] as const) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`sampling (${source}): expected an object, ignored`);
      continue;
    }
    const { default: def, routes } = raw as SamplingConfig;

    if (def !== undefined) {
      const mode = normalizeMode(def);
      if (mode === undefined) {
        warnings.push(
          `sampling.default (${source}): invalid mode ${JSON.stringify(def)}, using "on"`,
        );
      }
      config.default = mode ?? "on";
    }

    if (routes === undefined || routes === null) continue;
    if (typeof routes !== "object" || Array.isArray(routes)) {
      warnings.push(`sampling.routes (${source}): expected an object, ignored`);
      continue;
    }
    for (const [rawKey, rawMode] of Object.entries(routes)) {
      const key = normalizeRouteKey(rawKey);
      if (key === undefined) {
        warnings.push(
          `sampling.routes (${source}): invalid route key ${JSON.stringify(rawKey)}, ignored`,
        );
        continue;
      }
      const mode = normalizeMode(rawMode);
      if (mode === undefined) {
        warnings.push(
          `sampling.routes["${rawKey}"] (${source}): invalid mode ${JSON.stringify(rawMode)}, using "on"`,
        );
      }
      // Re-insert so a later duplicate also moves to the later position;
      // only the value is observable, but this keeps "later wins" literal.
      config.routes.delete(key);
      config.routes.set(key, mode ?? "on");
    }
  }

  return { config, warnings };
}

/**
 * SAMPLE-020..022. The mode for one request. `route` is the matched
 * pattern, absent when the adapter has none (bare http, an unmatched 404).
 */
export function resolveMode(
  config: NormalizedSampling,
  method: string,
  route: string | undefined,
): SamplingMode {
  if (route) {
    const path = normalizePath(route);
    if (path !== undefined) {
      const exact = config.routes.get(`${asciiUpper(method)} ${path}`);
      if (exact !== undefined) return exact;
      const any = config.routes.get(`* ${path}`);
      if (any !== undefined) return any;
    }
  }
  return config.default;
}

/**
 * SAMPLE-030, SAMPLE-031. `u` is uniform in [0, 1), rolled once per
 * request.
 */
export function decide(
  mode: SamplingMode,
  status: number,
  u: number,
): SamplingOutcome {
  if (mode === "off") return "drop";
  const isError = status >= 400;
  if (mode === "errors") return isError ? "full" : "drop";
  if (typeof mode !== "number" || isError) return "full";
  return u < mode ? "full" : "stub";
}

/**
 * SAMPLE-040. The canonical text form the hash is computed over, or `null`
 * when the config is the default (SAMPLE-041: nothing to report).
 */
export function canonicalSampling(config: NormalizedSampling): string | null {
  if (config.default === "on" && config.routes.size === 0) return null;
  // Keys are printable ASCII (SAMPLE-010), so code-unit order is byte order.
  const keys = [...config.routes.keys()].sort();
  let out = `default\t${modeToken(config.default)}\n`;
  for (const k of keys) out += `${k}\t${modeToken(config.routes.get(k)!)}\n`;
  return out;
}

/** SAMPLE-040. Lowercase hex SHA-256 of the canonical form, or `null`. */
export function samplingHash(config: NormalizedSampling): string | null {
  const canonical = canonicalSampling(config);
  if (canonical === null) return null;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** `0.1` -> `"0.1000"`, from the integer step count, never float formatting. */
function modeToken(mode: SamplingMode): string {
  if (typeof mode !== "number") return mode;
  const steps = Math.floor(mode * RATE_STEPS + 0.5);
  return `0.${String(steps).padStart(4, "0")}`;
}

function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}
