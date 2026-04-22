/**
 * The project a request belongs to. `id` is a stable identifier (never
 * changes for a given project); `name` is the human-readable display name
 * shown in the dashboard and can change freely.
 */
export interface Project {
  id: string;
  name: string;
}

/**
 * Info about the end-user making the request, attached to every captured log.
 */
export interface UserContext {
  /** Masked API key (run it through `restless.mask()` — never pass plaintext). */
  apiKey?: string;
  /** User email, if available */
  email?: string;
  /** The project this request belongs to */
  project?: Project;
  /** Anything extra — stored as-is on the log */
  [key: string]: unknown;
}

/**
 * Fields returned by the optional `enrich()` function — merged onto the log
 * when the SDK decides it needs to send fresh metadata for this user.
 */
export interface UserEnrichment {
  email?: string;
  [key: string]: unknown;
}

/**
 * What the user returns from the `setup()` callback on every request.
 *
 * Response modification (debug headers, log-url injection on errors, etc.)
 * is owned by the SDK — there is intentionally no `modifyBody` or `headers`
 * field here.
 */
export interface SetupResult {
  apiKey?: string;
  email?: string;
  project?: Project;

  /** Block this request (returns 403 by default — see README "Blocking"). */
  block?: boolean | { status?: number; message?: string };

  /**
   * Expensive enrichment (DB lookup, JWT verification, etc.). Only runs when
   * the SDK has no cached record that the server already knows this user.
   * The server can explicitly request a refresh by responding with
   * `needsEnrichment: [maskedApiKey]`.
   */
  enrich?: () => UserEnrichment | Promise<UserEnrichment>;

  /** Any additional fields — stored on the log as-is. */
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

/**
 * Public options for `restless(apiKey, opts?)`. Most things are auto-configured
 * from `.api/settings.json` and environment variables (see README + docs/INTERNALS.md):
 *
 *  - `RESTLESS_BASE_URL` — override the metrics server URL
 *  - `DEBUG=restless`    — emit debug logs on stderr
 *
 * Batching, flush intervals, and setup-mode behavior are hardcoded or
 * auto-detected.
 */
export interface ClientOptions {
  /**
   * Name of the API in `.api/settings.json`. Only required when that file
   * defines more than one API.
   */
  api?: string;

  /**
   * Extend the redaction denylists. The defaults already cover Authorization,
   * Cookie, password, token, apiKey, ssn, creditCard, cvv, etc. — see
   * docs/INTERNALS.md "Redaction".
   */
  redact?: {
    headers?: string[];
    bodyKeys?: string[];
    queryParams?: string[];
  };

  /** @internal — test hook for swapping the fetch implementation. */
  fetch?: typeof fetch;
}
