import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Walk up from `startDir` looking for a `.env` file. Stops at filesystem root.
 */
function findEnvFile(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Minimal `.env` parser. Handles `KEY=value`, `KEY="value"`, `KEY='value'`,
 * trims whitespace, skips blank lines and `#` comments, supports `export KEY=`.
 * Returns a flat object of vars. Intentionally tiny — this is a fallback for
 * older Node versions; users with real `.env` needs should use `dotenv`.
 */
function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * If `RESTLESS_KEY` isn't already in `process.env`, try to pick it up from
 * a `.env` file in the project tree. Prefers Node 20.6+'s built-in
 * `process.loadEnvFile()`; falls back to a minimal in-process parser for
 * Node 18.
 *
 * Always conservative: never overwrites existing env vars. Silent if no
 * `.env` is found (users who load env another way are unaffected).
 */
export function ensureEnvLoaded(startDir: string = process.cwd()): void {
  if (process.env.RESTLESS_KEY || process.env.README_API_KEY) return;

  const envPath = findEnvFile(startDir);
  if (!envPath) return;

  // Node 20.6+: built-in. In Node 20.12+ this respects existing vars; in
  // 20.6..20.11 it overwrites, so we guard by the pre-check above and fall
  // through to our own parser if it throws.
  const maybeLoad = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof maybeLoad === "function") {
    try {
      maybeLoad(envPath);
      return;
    } catch {
      // fall through to manual parse
    }
  }

  try {
    const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Silent — observability must never break the request path.
  }
}
