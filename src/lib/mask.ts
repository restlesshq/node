import { createHash } from "node:crypto";

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
 */
export function mask(apiKey: string | undefined | null): string | undefined {
  if (!apiKey) return undefined;
  const hash = createHash("sha512").update(apiKey).digest("base64");
  const last4 = apiKey.slice(-4);
  return `sha512-${hash}?${last4}`;
}
