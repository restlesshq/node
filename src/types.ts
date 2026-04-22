/**
 * Fully-resolved project data that goes on the wire. Inline fields from the
 * user's `setup` callback plus anything their `project.enrich(id)` returned,
 * merged together.
 */
export interface ProjectDetails {
  /** Human-readable display label for the dashboard. */
  label?: string;
  /** Contact email(s) associated with this project. A single string or an array. */
  email?: string | string[];
  [key: string]: unknown;
}

/**
 * What the user puts under `project:` in their setup callback.
 *
 * `id` is the cheap, stable identifier (sent every request, used as the
 * caching key). `label`, `email`, etc. are optional cheap inline fields.
 * `enrich(id)` is an optional async resolver for expensive lookups; it's
 * only called on the first request from each project id, then cached.
 */
export interface ProjectSetup {
  /** Stable identifier for the project/customer. Cached under this. */
  id?: string;

  /** Cheap inline fields. Included on every request. */
  label?: string;
  email?: string | string[];

  /**
   * Lazy resolver for expensive project metadata (DB lookup, JWT verification,
   * external HTTP call). Receives the project id as an argument. Runs only
   * on the first request from each id (or after server-driven invalidation),
   * then cached. Return any additional fields to merge into the project.
   */
  enrich?: (id: string) => ProjectDetails | Promise<ProjectDetails>;

  /** Any extra fields are preserved on the log. */
  [key: string]: unknown;
}

/** Per-request user context stored on each captured log. */
export interface UserContext {
  /** Masked end-user API key. */
  apiKey?: string;
  /** Resolved project: `id` plus cheap inline fields plus anything `enrich` returned. */
  project?: ProjectDetails & { id?: string };
  [key: string]: unknown;
}

/**
 * What the user returns from `setup(cb)` on every request.
 *
 * Keep top-level fields CHEAP (straight from the request — header, cookie,
 * JWT claim). Put anything expensive inside `project.enrich(id)`; the SDK
 * calls it lazily and dedups by project id.
 */
export interface SetupResult {
  /** Mask end-user API key with `restless.mask(...)`. Never pass plaintext. */
  apiKey?: string;

  /**
   * The project / customer / org this user belongs to. `project.id` is the
   * grouping dimension on the dashboard. Optional for single-tenant apps.
   */
  project?: ProjectSetup;

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
  /** Name of the API in `.api/settings.json`. Required when >1 API is defined. */
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
