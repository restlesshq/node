import { createHash } from "node:crypto";

// Setup-time placeholder strings the CLI (or copy-pasted docs) leave in
// curl examples. If a developer runs the demo curl without replacing
// these, we don't want them to land in the dashboard as a real-looking
// masked key — they'd cluster requests by an arbitrary substring of the
// placeholder ("HERE", "_KEY", etc.) and pollute the unauthenticated
// bucket. Treating them as falsy makes those requests look like what
// they are: an unauthenticated call.
const PLACEHOLDER_KEYS = new Set([
  "API_KEY_HERE",
  "YOUR_API_KEY",
  "YOUR_KEY",
  "REPLACE_ME",
]);

/**
 * Mask an end-user API key so it can be sent to the metrics server without
 * exposing the plaintext secret.
 *
 *     sha512-<base64(sha512(apiKey))>?<last4>
 *
 * The `?last4` suffix lets humans identify which key a hash came from without
 * breaking the primary identifier. See `docs/INTERNALS.md` for the full
 * format contract.
 *
 * **Falsy input returns `undefined`** — never hash `""` or `undefined` into a
 * real-looking mask. Callers should pass the raw key directly:
 *
 *     apiKey: restless.mask(req.headers.authorization)   // ✅ undefined if header missing
 *     apiKey: restless.mask(req.headers.authorization || 'anonymous')  // ❌ leaks "mous" as last4
 *
 * Known setup-time placeholders (see `PLACEHOLDER_KEYS`) also return
 * `undefined`, so unfinished example curls don't pollute the dashboard.
 */
export function mask(apiKey: string | undefined | null): string | undefined {
  if (!apiKey) return undefined;
  if (PLACEHOLDER_KEYS.has(apiKey)) return undefined;
  // Idempotent: if the input is already in our `sha512-…?last4` form
  // (e.g. accidental `mask(mask(key))` through some indirection), pass
  // it through unchanged rather than hashing the hash.
  if (apiKey.startsWith("sha512-")) return apiKey;
  const hash = createHash("sha512").update(apiKey).digest("base64");
  const last4 = apiKey.slice(-4);
  return `sha512-${hash}?${last4}`;
}
