/**
 * Redaction for sensitive values in captured requests.
 *
 * Format: `<REDACTED:<length>[:<last4>]>`
 *
 * We always show the length — it's useful for debugging ("my key should be
 * 40 chars, is this it?") without meaningfully reducing the search space
 * for a CSPRNG-generated secret.
 *
 * We show the last 4 characters ONLY when the value is long enough that
 * those 4 chars don't reconstruct most of it. Matches the `?last4` convention
 * in `mask()` — one pattern across the SDK, not two.
 */

/** Values shorter than this get no tail preview. */
const TAIL_MIN_LENGTH = 8;
const TAIL_CHARS = 4;

/** Default headers that ALWAYS get redacted. Case-insensitive. */
export const DEFAULT_HEADER_DENYLIST: readonly string[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
];

/**
 * Default body keys that ALWAYS get redacted. Comparison is case-insensitive
 * AND ignores `-` / `_`, so `api_key`, `apiKey`, `API-KEY` all match.
 */
export const DEFAULT_BODY_KEY_DENYLIST: readonly string[] = [
  "password",
  "pass",
  "pwd",
  "token",
  "secret",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessionid",
  "ssn",
  "creditcard",
  "ccnumber",
  "cvv",
  "cvc",
];

/** The query-param names we redact by default. Same normalization as body keys. */
export const DEFAULT_QUERY_PARAM_DENYLIST: readonly string[] =
  DEFAULT_BODY_KEY_DENYLIST;

export interface RedactOptions {
  /** Additional header names to redact (merged with defaults). */
  headers?: string[];
  /** Additional JSON body keys to redact (merged with defaults). */
  bodyKeys?: string[];
  /** Additional query-string param names to redact (merged with defaults). */
  queryParams?: string[];
}

/** Mask a single value. */
export function redactValue(value: string): string {
  const len = value.length;
  if (len < TAIL_MIN_LENGTH) return `<REDACTED:${len}>`;
  return `<REDACTED:${len}:${value.slice(-TAIL_CHARS)}>`;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "");
}

function buildDenySet(
  defaults: readonly string[],
  extra: string[] = [],
): Set<string> {
  return new Set([...defaults, ...extra].map(normalize));
}

/**
 * Headers that carry an HTTP auth-scheme prefix (e.g. `Authorization: Bearer
 * <token>`). For these we preserve the scheme word so a debugger reading the
 * dashboard can see at a glance whether the request used Bearer / Basic /
 * a custom scheme — only the credential portion gets replaced. Other
 * sensitive headers (`x-api-key`, `cookie`, etc.) are redacted as a whole
 * because the entire value IS the secret.
 */
const SCHEME_PREFIX_HEADERS: ReadonlySet<string> = new Set([
  normalize("authorization"),
  normalize("proxy-authorization"),
]);

/** Redact sensitive HTTP headers. Returns a new object; does not mutate input. */
export function redactHeaders(
  headers: Record<string, string>,
  extra: string[] = [],
): Record<string, string> {
  const deny = buildDenySet(DEFAULT_HEADER_DENYLIST, extra);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const norm = normalize(k);
    if (!deny.has(norm)) {
      out[k] = v;
      continue;
    }
    // Split on the FIRST whitespace run only — auth schemes are a single
    // token followed by the credential. Anything without a space (or
    // without anything after it) gets redacted whole, same as before.
    if (SCHEME_PREFIX_HEADERS.has(norm)) {
      const m = v.match(/^(\S+)(\s+)(\S.*)$/);
      if (m) {
        out[k] = `${m[1]}${m[2]}${redactValue(m[3])}`;
        continue;
      }
    }
    out[k] = redactValue(v);
  }
  return out;
}

/** Redact sensitive query-string params in a URL. Leaves the rest untouched. */
export function redactUrl(url: string, extra: string[] = []): string {
  const deny = buildDenySet(DEFAULT_QUERY_PARAM_DENYLIST, extra);
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (deny.has(normalize(key))) {
        const val = parsed.searchParams.get(key) || "";
        parsed.searchParams.set(key, redactValue(val));
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Recursively redact sensitive keys in a parsed JSON value. */
function redactJsonValue(val: unknown, deny: Set<string>): unknown {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map((v) => redactJsonValue(v, deny));
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (deny.has(normalize(k))) {
        if (v === null || v === undefined) out[k] = v;
        else if (typeof v === "string") out[k] = redactValue(v);
        else out[k] = `<REDACTED>`;
      } else {
        out[k] = redactJsonValue(v, deny);
      }
    }
    return out;
  }
  return val;
}

/** Redact sensitive keys in a JSON body string. Non-JSON passes through unchanged. */
export function redactBody(
  body: string | undefined,
  contentType: string | undefined,
  extra: string[] = [],
): string | undefined {
  if (!body) return body;
  if (!(contentType || "").toLowerCase().includes("application/json"))
    return body;
  try {
    const parsed = JSON.parse(body);
    const deny = buildDenySet(DEFAULT_BODY_KEY_DENYLIST, extra);
    return JSON.stringify(redactJsonValue(parsed, deny));
  } catch {
    return body;
  }
}

/** Truncate a body string that exceeds the limit. Appends a marker. */
export function truncateBody(
  body: string | undefined,
  maxBytes: number,
): string | undefined {
  if (!body) return body;
  const byteLen = Buffer.byteLength(body, "utf8");
  if (byteLen <= maxBytes) return body;
  // Slice by code units — over-approximates for multibyte chars, but safe.
  const sliced = body.slice(0, maxBytes);
  return `${sliced}\n[...TRUNCATED: original ${byteLen} bytes]`;
}
