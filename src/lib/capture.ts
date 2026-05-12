import type {
  CapturedRequest,
  OwnerDetails,
  SetupCallback,
  SetupResult,
} from "../types.js";
import { Uploader, type UploaderConfig } from "./uploader.js";
import { Blocklist } from "./blocklist.js";
import { EnrichCache } from "./enrichCache.js";
import {
  redactHeaders,
  redactUrl,
  redactBody,
  truncateBody,
  type RedactOptions,
} from "./redact.js";
import { fingerprint } from "./fingerprint.js";

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
  private callback: SetupCallback | null = null;
  private redactOpts: RedactOptions;

  constructor(cfg: EngineConfig) {
    this.blocklist = new Blocklist();
    this.enrichCache = new EnrichCache();
    this.redactOpts = cfg.redact || {};
    this.uploader = new Uploader({
      ...cfg,
      onResponse: (body) => this.handleServerResponse(body),
    });
  }

  setCallback(cb: SetupCallback) {
    this.callback = cb;
  }

  /**
   * Server can respond with `{ needsEnrichment: [<ownerId>...] }` to force
   * re-running `enrich` on the next request from that owner.
   */
  private handleServerResponse(body: unknown): void {
    if (!body || typeof body !== "object") return;
    const needs = (body as { needsEnrichment?: unknown }).needsEnrichment;
    if (!Array.isArray(needs)) return;
    for (const key of needs) {
      if (typeof key === "string") this.enrichCache.invalidate(key);
    }
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
    if (sanitized.response.status >= 400) {
      let body: unknown = sanitized.response.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          // leave as string; fingerprint() handles both shapes
        }
      }
      sanitized.errorFingerprint = fingerprint({
        status: sanitized.response.status,
        method: sanitized.request.method,
        route: sanitized.routePattern,
        responseHeaders: sanitized.response.headers,
        responseBody: body,
      });
    }
    this.uploader.push(sanitized);
  }

  async flush() {
    await this.uploader.flush();
  }
}
