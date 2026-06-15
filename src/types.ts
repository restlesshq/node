/**
 * Fully-resolved owner data that goes on the wire. Inline fields from the
 * user's `setup` callback plus anything their `owner.enrich(id)` returned,
 * merged together.
 */
export interface OwnerDetails {
  /** Human-readable display label for the dashboard. */
  label?: string;
  /** Contact email(s) associated with this owner. A single string or an array. */
  email?: string | string[];
  [key: string]: unknown;
}

/**
 * What the user puts under `owner:` in their setup callback.
 *
 * `id` is the PERMANENT, IMMUTABLE identifier for the workspace / tenant /
 * end-user this request belongs to. The Restless dashboard pins a project's
 * entire log history to this value. Once a customer has started producing
 * logs under one id, changing it fragments their history. Pick something
 * that will never change: a database primary key, a workspace UUID, a user
 * id. Never an API key, an email, a username, or any other rotatable value.
 *
 * `label`, `email`, etc. are optional cheap inline fields.
 * `enrich(id)` is an optional async resolver for expensive lookups; it's
 * only called on the first request from each id, then cached.
 */
export interface OwnerSetup {
  /**
   * Permanent, immutable identifier. **Must never change for this owner.**
   * See the interface docstring for picking guidance.
   */
  id?: string;

  /** Cheap inline fields. Included on every request. */
  label?: string;
  email?: string | string[];

  /**
   * Lazy resolver for expensive owner metadata (DB lookup, JWT verification,
   * external HTTP call). Receives the owner id as an argument. Runs only
   * on the first request from each id (or after server-driven invalidation),
   * then cached. Return any additional fields to merge into the owner.
   */
  enrich?: (id: string) => OwnerDetails | Promise<OwnerDetails>;

  /** Any extra fields are preserved on the log. */
  [key: string]: unknown;
}

/**
 * @deprecated Use `OwnerDetails`. Retained as an alias so existing imports
 * keep compiling; new code should reference `OwnerDetails`.
 */
export type ProjectDetails = OwnerDetails;

/**
 * @deprecated Use `OwnerSetup`. Retained as an alias so existing imports
 * keep compiling; new code should reference `OwnerSetup`.
 */
export type ProjectSetup = OwnerSetup;

/** Per-request user context stored on each captured log. */
export interface UserContext {
  /** Masked end-user API key. */
  apiKey?: string;
  /** Resolved owner: `id` plus cheap inline fields plus anything `enrich` returned. */
  project?: OwnerDetails & { id?: string };
  [key: string]: unknown;
}

/**
 * What the user returns from `setup(cb)` on every request.
 *
 * Keep top-level fields CHEAP (straight from the request — header, cookie,
 * JWT claim). Put anything expensive inside `owner.enrich(id)`; the SDK
 * calls it lazily and dedups by owner id.
 */
export interface SetupResult {
  /** Mask end-user API key with `restless.mask(...)`. Never pass plaintext. */
  apiKey?: string;

  /**
   * The workspace / tenant / end-user this request belongs to. `owner.id`
   * is the permanent grouping dimension on the dashboard.
   */
  owner?: OwnerSetup;

  /**
   * @deprecated Use `owner`. Accepted as an alias for backwards compatibility
   * with code wired before the rename; if both are provided, `owner` wins.
   */
  project?: OwnerSetup;

  /** Reject this request with a 4xx before the handler runs. */
  block?: boolean | { status?: number; message?: string };

  /** Any additional fields are stored on the log as-is. */
  [key: string]: unknown;
}

/** A captured request/response, framework-agnostic. */
export interface CapturedRequest {
  requestId: string;
  startedAt: string;
  routePattern?: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body?: string;
  };
  duration: number;
  user?: UserContext;
  /**
   * Stable identifier for an error response, computed at capture time. Set
   * for status >= 400. See `lib/fingerprint.ts` and `docs/INTERNALS.md`.
   */
  errorFingerprint?: {
    strategy:
      | "resource"
      | "endpoint"
      | "header"
      | "body-code"
      | "stack"
      | "message"
      | "route-only";
    key: string;
    reason: string;
  };
}

/** Subset of the HAR 1.2 spec we actually emit. */
export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    postData?: { mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    content: { size: number; mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  timings: { send: number; wait: number; receive: number };
}

/**
 * Callback passed into `restless.setup()`. Receives the framework-native
 * request object (Express `req`, Fastify `req`, Koa `ctx`, Hono `c`,
 * Next.js `Request`, Node `IncomingMessage`). Access headers / user /
 * session / whatever your middleware attached the way you normally would
 * in that framework.
 */
export type SetupCallback<TReq = any> = (
  req: TReq,
) => SetupResult | Promise<SetupResult>;

/** Public options for `restless(apiKey, opts?)`. */
export interface ClientOptions {
  /** Name of the API in `.restless/settings.json`. Required when >1 API is defined. */
  api?: string;

  /** Extend the redaction denylists (merged with built-in defaults). */
  redact?: {
    headers?: string[];
    bodyKeys?: string[];
    queryParams?: string[];
  };

  /** @internal — test hook for swapping the fetch implementation. */
  fetch?: typeof fetch;
}
