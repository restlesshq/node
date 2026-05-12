import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Shape of `.restless/settings.json` — created and owned by the `api` CLI
 * (`npx api setup`). See `install.md` for the full schema.
 */
/**
 * Additional redaction lists for this specific API. Merged with the SDK's
 * built-in defaults (see `src/lib/redact.ts`). Populated by the `api/`
 * setup tool after scanning code + OAS for auth mechanisms, and extensible
 * by hand.
 */
export interface RedactSettings {
  headers?: string[];
  bodyKeys?: string[];
  queryParams?: string[];
}

export interface ApiSettings {
  version: number;
  apis: Array<{
    id: string;
    name: string;
    rootDir?: string;
    oasFile?: string;
    framework?: string;
    language?: string;
    baseUrl?: string;
    internal?: boolean;
    lastSyncedAt?: string;
    requestIdPrefix?: string;
    /** The Restless-side project ID this API maps to. Each API in a
     * monorepo gets its own project, so this lives here, not at the root. */
    projectId?: string;
    redact?: RedactSettings;
  }>;
}

export interface ApiEntry {
  id: string;
  name: string;
  requestIdPrefix?: string;
  redact?: RedactSettings;
}

/**
 * Walk up from `startDir` looking for `.restless/settings.json`, the same way
 * tsconfig / package.json resolution works. Returns null if none is found
 * before we hit the filesystem root.
 */
function findSettingsFile(startDir: string): string | null {
  let dir = resolve(startDir);
  // Bounded loop — stop when dirname no longer changes (we're at /)
  while (true) {
    const candidate = join(dir, ".restless", "settings.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Module-level cache — one read per process. */
let cached: ApiSettings | null | undefined;

export function loadSettings(startDir: string = process.cwd()): ApiSettings | null {
  if (cached !== undefined) return cached;
  const file = findSettingsFile(startDir);
  if (!file) {
    cached = null;
    return null;
  }
  try {
    const raw = readFileSync(file, "utf8");
    cached = JSON.parse(raw) as ApiSettings;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

/** Test-only — reset the cache. Do not call from production code. */
export function _resetSettingsCache() {
  cached = undefined;
}

/**
 * Pick the API entry that matches `name`. If no name is given and there's
 * exactly one API defined, return it. If multiple APIs are defined and no
 * name is given, throw — we can't guess.
 */
export function resolveApi(
  settings: ApiSettings | null,
  name?: string,
): ApiEntry | null {
  if (!settings || !settings.apis?.length) return null;

  if (name) {
    const match =
      settings.apis.find((a) => a.name === name) ||
      settings.apis.find((a) => a.id === name);
    if (!match) {
      throw new Error(
        `@restlessai/sdk: no API named "${name}" in .api/settings.json (found: ${settings.apis
          .map((a) => a.name)
          .join(", ")})`,
      );
    }
    return {
      id: match.id,
      name: match.name,
      requestIdPrefix: match.requestIdPrefix,
      redact: match.redact,
    };
  }

  if (settings.apis.length === 1) {
    const only = settings.apis[0]!;
    return {
      id: only.id,
      name: only.name,
      requestIdPrefix: only.requestIdPrefix,
      redact: only.redact,
    };
  }

  throw new Error(
    `@restlessai/sdk: .api/settings.json has multiple APIs (${settings.apis
      .map((a) => a.name)
      .join(
        ", ",
      )}) — pass { api: "<name>" } to restless() to pick one.`,
  );
}
