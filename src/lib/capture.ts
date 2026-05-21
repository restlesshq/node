import type {
  CapturedRequest,
  OwnerDetails,
  SetupCallback,
  SetupResult,
} from "../types.js";
import { Uploader, type UploaderConfig } from "./uploader.js";
import { Blocklist } from "./blocklist.js";
import { EnrichCache } from "./enrichCache.js";
import { RecoveryCache } from "./recoveryCache.js";
import {
  redactHeaders,
  redactUrl,
  redactBody,
  truncateBody,
  type RedactOptions,
} from "./redact.js";
import { fingerprint, type Fingerprint } from "./fingerprint.js";

export const MAX_BODY_BYTES = 256 * 1024;

export interface EngineConfig extends Omit<UploaderConfig, "onResponse"> {
  redact?: RedactOptions;
}

/**
 * Shape `engine.resolve()` returns: the setup result with owner merged + enriched.
 *
 * Note the wire-format field is still `project` (server-coupled). The user
 * supplies `owner` in their callback; `resolve()` normalizes either `owner`
 * or the legacy `project` alias to this internal shape.
 */
export interface ResolvedSetup {
  apiKey?: string;
  project?: OwnerDetails & { id?: string };
  block?: SetupResult["block"];
  [key: string]: unknown;
}

export class CaptureEngine {
  readonly uploader: Uploader;
  readonly blocklist: Blocklist;
  readonly enrichCache: EnrichCache;
  readonly recoveryCache: RecoveryCache;
  private callback: SetupCallback | null = null;
  private redactOpts: RedactOptions;

  constructor(cfg: EngineConfig) {
    this.blocklist = new Blocklist();
    this.enrichCache = new EnrichCache();
    this.recoveryCache = new RecoveryCache();
    this.redactOpts = cfg.redact || {};
    this.uploader = new Uploader({
      ...cfg,
      onResponse: (body, batchFingerprints) =>
        this.handleServerResponse(body, batchFingerprints),
    });
  }

  setCallback(cb: SetupCallback) {
    this.callback = cb;
  }

  /**
   * Server-driven cache management piggybacked on the `/v1/request` upload
   * response. Two channels:
   *
   *   - `needsEnrichment: [ownerId...]` — invalidate per-owner enrich cache.
   *   - `recoveryMessages: { [fingerprintKey]: string }` — Agent Recovery
   *     "next steps" messages. We populate the positive cache from the
   *     dict, then negative-cache every fingerprint we just uploaded that
   *     the server didn't return a message for. This guarantees the
   *     SECOND occurrence of every error is a sync cache hit (positive or
   *     negative), so the hot path never waits on the network.
   */
  private handleServerResponse(
    body: unknown,
    batchFingerprints: string[] = [],
  ): void {
    if (!body || typeof body !== "object") return;
    const obj = body as {
      needsEnrichment?: unknown;
      recoveryMessages?: unknown;
    };

    if (Array.isArray(obj.needsEnrichment)) {
      for (const key of obj.needsEnrichment) {
        if (typeof key === "string") this.enrichCache.invalidate(key);
      }
    }

    const messages =
      obj.recoveryMessages && typeof obj.recoveryMessages === "object"
        ? (obj.recoveryMessages as Record<string, unknown>)
        : {};
    for (const key of batchFingerprints) {
      const v = messages[key];
      if (typeof v === "string") {
        this.recoveryCache.set(key, v);
      } else if (v === null) {
        this.recoveryCache.set(key, null);
      } else if (this.recoveryCache.get(key) === undefined) {
        // Only write a fresh negative entry; don't clobber a positive
        // cached value the server already gave us on a previous round.
        this.recoveryCache.set(key, null);
      }
    }
  }

  /**
   * Sync lookup for an injected Agent Recovery message. Hot-path safe:
   * returns from the local cache, never touches the network. A cold miss
   * just returns `undefined` and the adapter injects no message — the
   * next upload pulls the message back and the next occurrence hits.
   */
  lookupRecovery(fingerprintKey: string): string | undefined {
    const v = this.recoveryCache.get(fingerprintKey);
    return typeof v === "string" ? v : undefined;
  }

  /**
   * Compute (or no-op for non-errors) the error fingerprint for a captured
   * request. Adapters call this BEFORE building the debug-injection so
   * they can look up a recovery message; the result is then attached to
   * the CapturedRequest so `record()` doesn't recompute it.
   */
  computeFingerprint(captured: CapturedRequest): Fingerprint | undefined {
    if (captured.response.status < 400) return undefined;
    let parsed: unknown = captured.response.body;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // leave as string; fingerprint() handles both shapes
      }
    }
    return fingerprint({
      status: captured.response.status,
      method: captured.request.method,
      route: captured.routePattern,
      responseHeaders: captured.response.headers,
      responseBody: parsed,
    });
  }

  async resolve(req: unknown): Promise<ResolvedSetup> {
    if (!this.callback) return {};

    let result: SetupResult;
    try {
      result = (await this.callback(req)) || {};
    } catch {
      return {};
    }

    // Accept either `owner` (preferred) or `project` (legacy alias).
    // `owner` wins when both are supplied so a caller mid-migration can
    // safely add the new field without ripping out the old one yet.
    const { owner: rawOwner, project: rawProject, ...rest } = result;
    const raw = rawOwner || rawProject;
    if (!raw) {
      // No owner → just apiKey + anything else.
      return rest as ResolvedSetup;
    }

    const { enrich, ...inlineOwner } = raw;
    const cacheKey = raw.id || rest.apiKey;

    // We cache the enriched VALUE (not just a freshness marker) so
    // every upload carries user metadata, even when we skip running
    // the (potentially expensive) enrich callback. Without this every
    // request after the first would land in the dashboard as
    // "unauthenticated", since the server has no way to backfill.
    if (typeof enrich === "function" && raw.id && cacheKey) {
      const cached = this.enrichCache.get(cacheKey);
      if (cached) {
        return {
          ...rest,
          project: { ...inlineOwner, ...cached },
        } as ResolvedSetup;
      }
      try {
        const enriched = await enrich(raw.id);
        if (enriched && typeof enriched === "object") {
          this.enrichCache.set(cacheKey, enriched as Record<string, unknown>);
          return {
            ...rest,
            project: { ...inlineOwner, ...enriched },
          } as ResolvedSetup;
        }
      } catch {
        // Enrichment failure must not break the request path.
      }
    }

    return { ...rest, project: inlineOwner } as ResolvedSetup;
  }

  /** Redact + truncate, then enqueue. */
  record(captured: CapturedRequest) {
    const sanitized: CapturedRequest = {
      ...captured,
      request: {
        ...captured.request,
        url: redactUrl(captured.request.url, this.redactOpts.queryParams),
        headers: redactHeaders(
          captured.request.headers,
          this.redactOpts.headers,
        ),
        body: truncateBody(
          redactBody(
            captured.request.body,
            captured.request.headers["content-type"],
            this.redactOpts.bodyKeys,
          ),
          MAX_BODY_BYTES,
        ),
      },
      response: {
        ...captured.response,
        headers: redactHeaders(
          captured.response.headers,
          this.redactOpts.headers,
        ),
        body: truncateBody(
          redactBody(
            captured.response.body,
            captured.response.headers["content-type"],
            this.redactOpts.bodyKeys,
          ),
          MAX_BODY_BYTES,
        ),
      },
    };
    // Fingerprint errors only. The server treats an empty fingerprint as
    // "this was a successful response" and skips error grouping.
    //
    // Reuse a fingerprint already attached by the adapter — adapters
    // compute it pre-response so they can look up an Agent Recovery
    // message; recomputing here would do redundant string work on the
    // upload path.
    if (
      !sanitized.errorFingerprint &&
      sanitized.response.status >= 400
    ) {
      sanitized.errorFingerprint = this.computeFingerprint(sanitized);
    }
    this.uploader.push(sanitized);
  }

  async flush() {
    await this.uploader.flush();
  }
}
