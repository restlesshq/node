/**
 * The conformance operation table for the Node SDK.
 *
 * One function, `runOp(op, input)`, mapping a driver operation name to the
 * reference implementation in `src/`. Two things consume it and they MUST
 * stay in agreement:
 *
 *   - `test/spec.vectors.test.ts`, which computes the expected values in
 *     `spec/vectors/*.json`
 *   - `spec/driver/node.ts`, the Node conformance driver
 *
 * They share this file precisely so the vectors cannot describe behaviour
 * the driver does not exhibit.
 *
 * Every port implements the same table over its own internals. See
 * `spec/driver/PROTOCOL.md` for the operation signatures.
 */

import { mask } from "../src/lib/mask.js";
import {
  redactValue,
  redactHeaders,
  redactUrl,
  redactBody,
  truncateBody,
} from "../src/lib/redact.js";
import {
  fingerprint,
  normalizeRoute,
  normalizeMessage,
  projectRelative,
} from "../src/lib/fingerprint.js";
import { toHarEntry } from "../src/lib/har.js";
import {
  formatRequestId,
  stripRequestIdPrefix,
} from "../src/lib/requestId.js";
import {
  recoverySlug,
  requestIdResponseHeaders,
} from "../src/adapters/_shared.js";
import type { CapturedRequest } from "../src/types.js";

/** JSON has no `undefined`. Absence is represented as `null` on the wire. */
function j<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

type Input = Record<string, any>;

export const OPS: Record<string, (input: Input) => unknown> = {
  // --- masking ---
  mask: (i) => j(mask(i.apiKey)),

  // --- redaction ---
  redactValue: (i) => redactValue(i.value),
  redactHeaders: (i) => redactHeaders(i.headers, i.extra ?? []),
  redactUrl: (i) => redactUrl(i.url, i.extra ?? []),
  redactBody: (i) => j(redactBody(j(i.body) ?? undefined, j(i.contentType) ?? undefined, i.extra ?? [])),
  truncateBody: (i) => j(truncateBody(j(i.body) ?? undefined, i.maxBytes)),

  // --- fingerprinting ---
  // `reason` is human-facing prose, explicitly not contract surface
  // (CONTRACT.md FP-003), so it is not emitted for comparison.
  fingerprint: (i) => {
    const fp = fingerprint({
      status: i.status,
      method: j(i.method) ?? undefined,
      route: j(i.route) ?? undefined,
      responseHeaders: j(i.responseHeaders) ?? undefined,
      responseBody: i.responseBody,
      stackTrace: j(i.stackTrace) ?? undefined,
    });
    // FP-047's previousKey is contract surface; `reason` is not (FP-003).
    return fp.previousKey
      ? { strategy: fp.strategy, key: fp.key, previousKey: fp.previousKey }
      : { strategy: fp.strategy, key: fp.key };
  },
  normalizeRoute: (i) => normalizeRoute(j(i.route) ?? undefined),
  normalizeMessage: (i) => normalizeMessage(i.message),
  // FP-042 is shared across every SDK even though frame PARSING is not
  // (FP-044/FP-046), so path normalization gets its own dialect-free op.
  projectRelative: (i) => projectRelative(i.file),

  // --- request ids ---
  formatRequestId: (i) => formatRequestId(i.rawId, j(i.prefix) ?? undefined),
  stripRequestIdPrefix: (i) => stripRequestIdPrefix(i.requestId),
  requestIdHeaders: (i) =>
    requestIdResponseHeaders(
      i.ourId,
      i.incomingHeaders ?? {},
      j(i.prefix) ?? undefined,
      i.hasApiKey,
    ),

  // --- injection ---
  recoverySlug: (i) => recoverySlug(j(i.method) ?? undefined, j(i.path) ?? undefined),

  // --- HAR ---
  harEntry: (i) => toHarEntry(i.captured as CapturedRequest),
};

export function runOp(op: string, input: Input): unknown {
  const fn = OPS[op];
  if (!fn) throw new Error(`unknown op: ${op}`);
  return fn(input);
}
