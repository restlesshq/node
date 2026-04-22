import type {
  ClientOptions,
  SetupCallback,
  SetupResult,
  CapturedRequest,
  UserContext,
  HarEntry,
  ProjectDetails,
  UserEnrichment,
} from "./types.js";
import { CaptureEngine } from "./lib/capture.js";
import { mask } from "./lib/mask.js";
import {
  newRequestId,
  formatRequestId,
  stripRequestIdPrefix,
} from "./lib/requestId.js";
import { loadSettings, resolveApi } from "./lib/settings.js";
import { resolveBaseUrl } from "./lib/uploader.js";

export type {
  ClientOptions,
  SetupCallback,
  SetupResult,
  CapturedRequest,
  UserContext,
  HarEntry,
  ProjectDetails,
  UserEnrichment,
};

/** Client returned by `restless(apiKey, opts?)`. */
export interface RestlessClient {
  /** Register a per-request callback. Pass the return value to a framework adapter. */
  setup(cb: SetupCallback): { __restless: RestlessClient; __cb: SetupCallback };

  /**
   * Hash an end-user API key into the shared `sha512-<base64>?<last4>` format.
   * Returns `undefined` for falsy input. Pass the raw header through; don't
   * substitute a string like `'anonymous'` (the last 4 chars would leak).
   */
  mask(apiKey: string | undefined | null): string | undefined;

  /** Force-upload the queued batch. */
  flush(): Promise<void>;

  /** @internal: adapters only. */
  engine: CaptureEngine;
}

/**
 * Construct a restless client.
 *
 *     const restless = require('@restlessai/sdk/express')(process.env.RESTLESS_KEY);
 *     app.use(restless.setup((req) => ({
 *       apiKey:    restless.mask(req.headers.authorization),
 *       projectId: req.headers['x-tenant-id'],
 *     })));
 */
function restless(apiKey?: string, opts: ClientOptions = {}): RestlessClient {
  const resolvedKey =
    apiKey ||
    process.env.RESTLESS_KEY ||
    process.env.README_API_KEY ||
    "";

  // Read .api/settings.json for per-API config: the requestIdPrefix and the
  // redact lists. We no longer auto-populate a project on the SetupResult:
  // projectId is now a customer/tenant concept the user supplies per-request.
  let requestIdPrefix: string | undefined;
  let settingsRedact: ClientOptions["redact"] | undefined;
  try {
    const settings = loadSettings();
    const api = resolveApi(settings, opts.api);
    if (api) {
      requestIdPrefix = api.requestIdPrefix;
      settingsRedact = api.redact;
    }
  } catch (err) {
    throw err;
  }

  // Settings-sourced redaction + user-sourced redaction are BOTH additive on
  // top of the built-in defaults.
  const mergedRedact: ClientOptions["redact"] = {
    headers: [
      ...(settingsRedact?.headers || []),
      ...(opts.redact?.headers || []),
    ],
    bodyKeys: [
      ...(settingsRedact?.bodyKeys || []),
      ...(opts.redact?.bodyKeys || []),
    ],
    queryParams: [
      ...(settingsRedact?.queryParams || []),
      ...(opts.redact?.queryParams || []),
    ],
  };

  const engine = new CaptureEngine({
    apiKey: resolvedKey,
    baseUrl: resolveBaseUrl(),
    requestIdPrefix,
    fetchImpl: opts.fetch,
    redact: mergedRedact,
  });

  const client: RestlessClient = {
    engine,
    mask,
    flush: () => engine.flush(),
    setup(cb) {
      engine.setCallback(cb);
      return { __restless: client, __cb: cb };
    },
  };

  return client;
}

export default restless;

export {
  mask,
  newRequestId,
  formatRequestId,
  stripRequestIdPrefix,
  CaptureEngine,
};
