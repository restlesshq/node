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

/**
 * Mask a single value.
 *
 * Length and tail are counted in Unicode CODE POINTS, not UTF-16 code units.
 * JS `.length` reports 2 for an astral char (emoji), Python reports 1, Go's
 * `len()` reports 4 bytes — so a code-unit count would make the sentinel
 * disagree across SDKs for the same secret, and `slice(-4)` could split a
 * surrogate pair. See spec/CONTRACT.md REDACT-002.
 */
export function redactValue(value: string): string {
  const points = [...value];
  const len = points.length;
  if (len < TAIL_MIN_LENGTH) return `<REDACTED:${len}>`;
  return `<REDACTED:${len}:${points.slice(-TAIL_CHARS).join("")}>`;
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

/**
 * PRIM-002. The whitespace set, enumerated. Used for the auth-scheme split
 * so the boundary does not depend on a regex engine's `\s`.
 */
const WS_CHARS = new Set([
  "\t", "\n", "\v", "\f", "\r", " ", "\u00a0", "\u1680", "\u2000",
  "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008",
  "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff",
]);

/**
 * Split `Bearer <credential>` into its three parts, or null when the value
 * has no scheme prefix to preserve.
 *
 * Written as an explicit scan rather than `/^(\S+)(\s+)(\S.*)$/` because
 * that regex is not portable: JS's `.` excludes CR, LS and PS, while
 * Python's `re.DOTALL` includes them and its `\s` covers a wider set again.
 * A credential containing a stray CR therefore took the scheme-preserving
 * branch in one SDK and the redact-whole branch in another, for the same
 * header. See spec/CONTRACT.md REDACT-016.
 */
function splitAuthScheme(
  value: string,
): { scheme: string; gap: string; credential: string } | null {
  const chars = [...value];
  let i = 0;
  while (i < chars.length && !WS_CHARS.has(chars[i]!)) i++;
  // No whitespace at all, or the value starts with it: nothing to preserve.
  if (i === 0 || i >= chars.length) return null;
  const scheme = chars.slice(0, i).join("");
  let j = i;
  while (j < chars.length && WS_CHARS.has(chars[j]!)) j++;
  if (j >= chars.length) return null; // whitespace but no credential after it
  return {
    scheme,
    gap: chars.slice(i, j).join(""),
    credential: chars.slice(j).join(""),
  };
}

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
    if (SCHEME_PREFIX_HEADERS.has(norm)) {
      const split = splitAuthScheme(v);
      if (split) {
        out[k] = `${split.scheme}${split.gap}${redactValue(split.credential)}`;
        continue;
      }
    }
    out[k] = redactValue(v);
  }
  return out;
}

/**
 * Characters that survive percent-encoding unescaped: the RFC 3986
 * unreserved set. Named explicitly rather than deferring to a builtin
 * because every language's builtin picks a different set —
 * `encodeURIComponent` additionally leaves `!'()*` alone, Python's `quote`
 * defaults differ again, and Go's differ from both. See
 * spec/CONTRACT.md REDACT-028.
 */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

function percentEncode(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.test(ch)
      ? ch
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Decode one query component: `+` is a space, `%XX` is a byte.
 *
 * Iterates CODE POINTS, not UTF-16 code units. Indexing by code unit walks
 * straight into the middle of an astral character and hands each surrogate
 * half to the encoder separately, which turns one emoji into two U+FFFD
 * replacement characters — so the sentinel reports the wrong length and the
 * tail is garbage. See spec/CONTRACT.md REDACT-029 and PRIM-010.
 */
export function percentDecode(value: string): string {
  const bytes: number[] = [];
  const chars = [...value];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === "+") {
      bytes.push(0x20);
      continue;
    }
    if (ch === "%") {
      const hex = chars.slice(i + 1, i + 3).join("");
      if (hex.length === 2 && /^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Redact sensitive query-string params in a URL, in place.
 *
 * Only the matched VALUES are rewritten. Scheme, host, port, path,
 * parameter order, separators and fragment come through byte for byte.
 *
 * This used to parse with `new URL()` and return `parsed.toString()`, which
 * was wrong twice over:
 *
 *   1. **It lost data.** `searchParams.set()` collapses every entry sharing
 *      a name into one, so `?token=a&token=b` came out as a single param —
 *      the second value silently vanished from the captured URL. Worse, the
 *      key snapshot was taken before mutation, so the second iteration
 *      re-redacted the sentinel written by the first and emitted a
 *      nonsense length (`<REDACTED:18:aaa>>` for a 10-character secret).
 *   2. **It was unportable.** Round-tripping through a URL parser applies
 *      WHATWG normalization (default ports dropped, percent-encoding case
 *      rewritten), and no other language's URL library reproduces those
 *      rules. A Python or Go port could not match it without reimplementing
 *      the WHATWG spec.
 *
 * Same reasoning as the body passthrough in `redactBody`: touch only what
 * has to change. See spec/CONTRACT.md REDACT-025.
 */
export function redactUrl(url: string, extra: string[] = []): string {
  const deny = buildDenySet(DEFAULT_QUERY_PARAM_DENYLIST, extra);

  const q = url.indexOf("?");
  if (q === -1) return url;

  const head = url.slice(0, q + 1);
  const rest = url.slice(q + 1);

  const hash = rest.indexOf("#");
  const query = hash === -1 ? rest : rest.slice(0, hash);
  const tail = hash === -1 ? "" : rest.slice(hash);
  if (!query) return url;

  const parts = query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq === -1) return pair;
    const rawKey = pair.slice(0, eq);
    const rawVal = pair.slice(eq + 1);
    if (!deny.has(normalize(percentDecode(rawKey)))) return pair;
    return `${rawKey}=${percentEncode(redactValue(percentDecode(rawVal)))}`;
  });

  return head + parts.join("&") + tail;
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

/**
 * Does any object key anywhere in this value normalize into the deny set?
 *
 * Used to decide whether we have to re-serialize at all. Walks the parsed
 * value rather than pattern-matching the raw text so every SDK reaches the
 * same verdict using its own JSON parser, with no regex-dialect or
 * escape-decoding differences to get wrong.
 */
function containsDeniedKey(val: unknown, deny: Set<string>): boolean {
  if (val === null || val === undefined) return false;
  if (Array.isArray(val)) return val.some((v) => containsDeniedKey(v, deny));
  if (typeof val === "object") {
    for (const [k, v] of Object.entries(val)) {
      if (deny.has(normalize(k))) return true;
      if (containsDeniedKey(v, deny)) return true;
    }
  }
  return false;
}

/**
 * Redact sensitive keys in a JSON body string. Non-JSON passes through
 * unchanged.
 *
 * When the body contains NOTHING to redact we return the caller's original
 * string byte-for-byte rather than a re-serialized copy. Two reasons, and
 * both matter more than the tidiness of always normalizing:
 *
 *   1. Fidelity. A parse/serialize round-trip is lossy in every language,
 *      differently: JS silently mangles integers above 2^53 (an int64 id
 *      like 9007199254740993 comes back as ...992) and renders `1.0` as
 *      `1`; Python preserves both. We were corrupting customer payloads
 *      on the way to the dashboard for no benefit.
 *   2. Portability. Re-serialization is where SDKs disagree — key order
 *      (Go's encoder sorts, JS preserves insertion order), separators
 *      (Python defaults to ", "), number rendering. Skipping it for the
 *      overwhelming majority of bodies removes the divergence entirely
 *      instead of trying to specify it away.
 *
 * Bodies that DO carry a secret still get re-serialized — there is no way
 * to rewrite a value without doing so — and for those the contract pins
 * compact separators and preserved key order. See spec/CONTRACT.md
 * REDACT-020..023.
 */
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
    if (!containsDeniedKey(parsed, deny)) return body;
    return JSON.stringify(redactJsonValue(parsed, deny));
  } catch {
    return body;
  }
}

/**
 * Truncate a body string that exceeds the limit. Appends a marker.
 *
 * The cut is made in UTF-8 BYTES and then backed off to the nearest
 * character boundary, so the kept prefix is always a complete sequence of
 * Unicode scalar values and never ends in a broken multi-byte character.
 * The previous implementation compared byte length but sliced UTF-16 code
 * units, which cut at a different point in every language (and could
 * emit a lone surrogate). See spec/CONTRACT.md REDACT-030.
 */
export function truncateBody(
  body: string | undefined,
  maxBytes: number,
): string | undefined {
  if (!body) return body;
  const buf = Buffer.from(body, "utf8");
  if (buf.length <= maxBytes) return body;
  // Walk back off any UTF-8 continuation byte (0b10xxxxxx) so we cut on a
  // character boundary rather than mid-sequence.
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  const sliced = buf.subarray(0, end).toString("utf8");
  return `${sliced}\n[...TRUNCATED: original ${buf.length} bytes]`;
}
