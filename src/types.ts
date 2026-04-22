/**
 * Project metadata that the `enrich` callback fills in. Sent on the first
 * request from each project (or after server-driven invalidation), cached
 * in-memory for subsequent requests.
 */
export interface ProjectDetails {
  /** Human-readable display label for the dashboard. */
  label?: string;
  /** Contact email(s) associated with this project. A single string or an array of strings. */
  email?: string | string[];
  [key: string]: unknown;
}

/**
 * What `enrich()` returns. Currently a `project` block is the only
 * standard field; any additional fields are preserved on the log as-is.
 */
export interface UserEnrichment {
  project?: ProjectDetails;
  [key: string]: unknown;
}

/** Per-request user context stored on each captured log. */
export interface UserContext {
  /** Masked end-user API key. */
  apiKey?: string;
  /** Stable project / customer identifier. Grouping key on the dashboard. */
  projectId?: string;
  /** Enriched project metadata (from enrich). */
  project?: ProjectDetails;
  [key: string]: unknown;
}

/**
 * What the user returns from `setup(cb)` on every request.
 *
 * The top-level fields (apiKey, projectId) are CHEAP and sent every request.
 * Anything expensive (DB lookups, JWT verification) goes inside `enrich()` —
 * the SDK only calls it when the server doesn't already have the data cached.
 */
export interface SetupResult {
  /** Mask end-user API key with `restless.mask(...)`. Never pass plaintext. */
  apiKey?: string;

  /**
   * Stable identifier for the project / customer / org this user belongs to.
   * Used as the primary grouping dimension on the dashboard — one project
   * can contain many end-users, each with their own `apiKey`.
   */
  projectId?: string;

  /** Reject this request with a 4xx before the handler runs. */
  block?: boolean | { status?: number; message?: string };

  /**
   * Expensive user / project lookup. Only runs when the SDK has no cached
   * record that the server already knows this project. The server can force
   * a refresh by responding with `needsEnrichment: [projectId]`.
   */
  enrich?: () => UserEnrichment | Promise<UserEnrichment>;

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

/** Callback passed into `restless.setup()`. */
export type SetupCallback = (
  req: {
    method: string;
    url: string;
    headers: Record<string, string>;
  },
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
