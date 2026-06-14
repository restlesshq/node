// Stable identifier for an HTTP error response. The SDK computes one at
// capture time and ships it with the log; the metrics server stores it; the
// site groups by it; the customer attaches a "next steps" message to a group;
// the SDK looks the message up at runtime and injects it into the response.
//
// Stability is the whole point. The fingerprint must:
//   - survive minor message changes (different IDs, timestamps, user input)
//   - survive code edits (different line numbers, reformatting)
//   - separate truly different errors (different status, different code)
//
// Anything per-request (numbers, IDs, emails, quoted user input) gets stripped
// before it can influence the key.
//
// **This format is a cross-SDK contract**, the same way `mask()` is. If you
// change the algorithm here, every other SDK port (Python, Ruby, etc.) and the
// metrics server's stored fingerprints have to move with it. See
// `docs/INTERNALS.md` for the spec.

export type CapturedError = {
  status: number;
  method?: string;
  route?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  stackTrace?: string | string[];
};

export type Strategy =
  | "resource"
  | "endpoint"
  | "header"
  | "body-code"
  | "stack"
  | "message"
  | "route-only";

export type Fingerprint = {
  strategy: Strategy;
  key: string;
  reason: string;
};

const CODE_FIELDS = ["code", "error_code", "errorCode", "type"] as const;
const NESTED_PATHS: ReadonlyArray<readonly string[]> = [
  ["error", "code"],
  ["error", "type"],
  ["error", "error_code"],
];

// Strategies tried in priority order; first one that produces a key wins. 404
// is intercepted first (it's route-oriented, not code-oriented - see below);
// the rest run from most deterministic (header) to best-effort (route-only).
export function fingerprint(err: CapturedError): Fingerprint {
  const status = err.status;
  const method = err.method || "GET";

  // 0. 404 is resource-oriented and takes priority over the code-based
  // strategies (a generic "not_found" code is the same on every route, so
  // grouping 404s by code is useless for recovery). There are exactly TWO
  // kinds of 404, and they need opposite advice:
  //   - WITH a path parameter (e.g. GET /car/{id}): the route is fine, the
  //     addressed resource is missing. Fix: verify the id; list the parent
  //     collection (drop the id segment) to find valid ones.
  //   - WITHOUT a path parameter (e.g. /imadethisup, or a paramless route):
  //     the path/endpoint itself didn't resolve. Fix: call a real endpoint.
  // We deliberately do NOT key per-route: the agent that receives the hint
  // already knows the concrete path it called, so one general hint per kind is
  // actionable, and a human only ever writes two 404 hints total (not one per
  // route). `err.route` is the matched route pattern (absent when nothing
  // matched), and `normalizeRoute` turns any concrete ids into `:id`, so the
  // presence of a `:`/`{` template segment is the "has a parameter" signal.
  if (status === 404) {
    const route = err.route ? normalizeRoute(err.route) : "";
    if (/[:{]/.test(route)) {
      return {
        strategy: "resource",
        key: "404:resource",
        reason: `404 on a parameterized route (${method} ${route}); the addressed resource was not found`,
      };
    }
    return {
      strategy: "endpoint",
      key: "404:endpoint",
      reason: route
        ? `404 on ${method} ${route}; no resource at this path`
        : "404 on a path that matched no route; the endpoint does not exist",
    };
  }

  // 1. Explicit header. Fully deterministic; the customer opted in.
  const headerCode = readHeaderCode(err.responseHeaders);
  if (headerCode) {
    return {
      strategy: "header",
      key: `${status}:${headerCode}`,
      reason: `x-restless-error-code header: "${headerCode}"`,
    };
  }

  // 2. Code-like field in the response body. Stripe/AWS/Twilio-style APIs land here.
  const bodyCode = readBodyCode(err.responseBody);
  if (bodyCode) {
    return {
      strategy: "body-code",
      key: `${status}:${bodyCode}`,
      reason: `code field in body: "${bodyCode}"`,
    };
  }

  // 3. Stack trace (5xx with a thrown exception). Use file + function only.
  // No line numbers: those change every time someone adds a comment above the throw.
  if (status >= 500 && err.stackTrace) {
    const frame = topUserFrame(err.stackTrace);
    if (frame) {
      return {
        strategy: "stack",
        key: `${status}:${frame.file}:${frame.fn}`,
        reason: `top user frame: ${frame.fn} in ${frame.file}`,
      };
    }
  }

  // 4. Normalized message + templated route. Catches Express-default style errors.
  const route = normalizeRoute(err.route);
  const msg = normalizeMessage(extractMessage(err.responseBody));
  if (msg) {
    return {
      strategy: "message",
      key: `${status}:${method}:${route}:${msg}`,
      reason: `message normalized to "${msg}"`,
    };
  }

  // 5. Status + route only. Coarse but at least groups all unhandled responses on a route.
  return {
    strategy: "route-only",
    key: `${status}:${method}:${route}`,
    reason: "no usable code or message; falling back to status + route",
  };
}

function readHeaderCode(headers?: Record<string, string>): string | null {
  if (!headers) return null;
  // HTTP header names are case-insensitive.
  const lower: Record<string, string> = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  const v = lower["x-restless-error-code"];
  return looksLikeCode(v) ? v : null;
}

function readBodyCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  for (const f of CODE_FIELDS) {
    const v = obj[f];
    if (looksLikeCode(v)) return v;
  }
  for (const path of NESTED_PATHS) {
    let v: unknown = obj;
    for (const p of path)
      v = (v as Record<string, unknown> | null | undefined)?.[p];
    if (looksLikeCode(v)) return v;
  }
  return null;
}

// A "code" must look like an identifier, not a sentence or a UUID. This filter
// keeps "card_declined" and "AUTH_MISMATCH" but rejects "Your card was declined."
function looksLikeCode(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 64 &&
    /^[a-zA-Z][a-zA-Z0-9_.\-]*$/.test(v)
  );
}

// Walks the stack from the top, skipping frames that aren't user code.
// Returns { file, fn } where file is project-relative when possible.
function topUserFrame(
  stack: string | string[],
): { file: string; fn: string } | null {
  const lines = typeof stack === "string" ? stack.split("\n") : stack;
  for (const raw of lines) {
    const line = String(raw);
    if (line.includes("node_modules")) continue;
    if (line.includes("node:internal")) continue;
    if (line.includes("@restlessai/sdk")) continue;
    // Two common shapes:
    //   "    at functionName (/abs/path/file.js:12:34)"
    //   "    at /abs/path/file.js:12:34"
    const withFn = line.match(/at\s+(\S+)\s+\((.+?):\d+:\d+\)/);
    const withoutFn = line.match(/at\s+(.+?):\d+:\d+/);
    let fn = "anonymous";
    let file: string;
    if (withFn) {
      fn = withFn[1];
      file = withFn[2];
    } else if (withoutFn) {
      file = withoutFn[1];
    } else {
      continue;
    }
    file = projectRelative(file);
    return { file, fn };
  }
  return null;
}

// Strip absolute path prefix down to a project-relative path. The exact prefix
// varies per machine; we want the same fingerprint on dev and prod.
function projectRelative(file: string): string {
  const m = file.match(
    /\/(?:src|lib|app|api|routes|controllers|handlers)\/.+$/,
  );
  return m ? m[0].slice(1) : file.split("/").slice(-2).join("/");
}

// Replace path params with templates so /users/123 and /users/456 collapse.
// If the customer already passed a templated route (/users/:id) this is a no-op.
function normalizeRoute(route?: string): string {
  if (!route) return "/";
  return route
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi,
      "/:id",
    )
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/:id");
}

function extractMessage(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  const obj = body as Record<string, unknown>;
  if (typeof obj.message === "string") return obj.message;
  const nested = obj.error as Record<string, unknown> | string | undefined;
  if (typeof nested === "string") return nested;
  if (
    nested &&
    typeof nested === "object" &&
    typeof nested.message === "string"
  ) {
    return nested.message;
  }
  return "";
}

// The fallback strategy depends entirely on this normalizer being aggressive.
// Anything that varies request-to-request must be erased before the first 6
// words are taken: URLs, emails, quoted user input, and crucially any token
// containing a digit (UUIDs, hex IDs, "user_abc123", "sk_live_4242", etc.).
// Stripping just digits isn't enough: "abc123" would become "abc" and still
// influence the key, breaking grouping when the surrounding ID changes.
export function normalizeMessage(msg: string): string {
  if (!msg) return "";
  return msg
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ") // urls
    .replace(/\S+@\S+\.\S+/g, " ") // emails
    .replace(/['"`][^'"`]*['"`]/g, " ") // quoted user input
    .replace(/\b[\w-]*\d[\w-]*\b/gi, " ") // any whole word containing a digit
    .replace(/[^\w\s-]/g, " ") // residual punctuation
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 6)
    .join("-");
}
