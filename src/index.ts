import type {
  ClientOptions,
  SetupCallback,
  SetupResult,
  CapturedRequest,
  UserContext,
  HarEntry,
  Project,
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
  Project,
};

/** Client returned by `restless(apiKey, opts?)`. */
export interface RestlessClient {
  /** Register a per-request callback. Pass the return value to a framework adapter. */
  setup(cb: SetupCallback): { __restless: RestlessClient; __cb: SetupCallback };

  /**
   * Hash an end-user API key into the shared `sha512-<base64>?<last4>` format.
   * Returns `undefined` for falsy input — pass the raw header through; don't
   * substitute a string like `'anonymous'` (the last 4 chars would leak).
   */
  mask(apiKey: string | undefined | null): string | undefined;

  /** Force-upload the queued batch. */
  flush(): Promise<void>;

  /** @internal — adapters only. */
  engine: CaptureEngine;
}

/**
 * Construct a restless client.
 *
 *     const restless = require('@restlesshq/node/express')(process.env.RESTLESS_KEY);
 *     app.use(restless.setup((req) => ({
 *       apiKey: restless.mask(req.headers.authorization),
 *     })));
 *
 * Auto-loads `.api/settings.json` (walking up from `cwd`) to populate the
 * project info and request-ID prefix. If that file defines multiple APIs,
 * pass `{ api: "<name>" }` to pick one.
 */
function restless(apiKey?: string, opts: ClientOptions = {}): RestlessClient {
  const resolvedKey =
    apiKey ||
    process.env.RESTLESS_KEY ||
    process.env.README_API_KEY ||
    "";

  // Pull defaults from .api/settings.json (best-effort — the file may not exist)
  let defaultProject: Project | undefined;
  let requestIdPrefix: string | undefined;
  let settingsRedact: ClientOptions["redact"] | undefined;
  try {
    const settings = loadSettings();
    const api = resolveApi(settings, opts.api);
    if (api) {
      defaultProject = { id: api.id, name: api.name };
      requestIdPrefix = api.requestIdPrefix;
      settingsRedact = api.redact;
    }
  } catch (err) {
    // Multiple-APIs error — surface it so the user fixes their call site.
    throw err;
  }

  // Settings-sourced redaction + user-sourced redaction are BOTH additive on
  // top of the built-in defaults. Neither overrides the other — they concat.
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
    defaultProject,
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
