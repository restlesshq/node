import type {
  CapturedRequest,
  SetupCallback,
  SetupResult,
  UserEnrichment,
} from "../types.js";

/** Shape returned by `engine.resolve()` — setup result + optional enrichment payload. */
export type ResolvedSetup = SetupResult & { _enriched?: UserEnrichment };
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

export const MAX_BODY_BYTES = 256 * 1024;

export interface EngineConfig extends Omit<UploaderConfig, "onResponse"> {
  redact?: RedactOptions;
}

/**
 * Shared capture engine. Resolves setup callbacks (including lazy enrichment
 * keyed by projectId), applies redaction + truncation, and hands the result
 * to the uploader.
 */
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
   * Called after every successful upload with the server's parsed response.
   * Handles `needsEnrichment: string[]` — project IDs (or apiKeys when no
   * project) the server wants re-enriched on the next request.
   */
  private handleServerResponse(body: unknown): void {
    if (!body || typeof body !== "object") return;
    const needs = (body as { needsEnrichment?: unknown }).needsEnrichment;
    if (!Array.isArray(needs)) return;
    for (const key of needs) {
      if (typeof key === "string") this.enrichCache.invalidate(key);
    }
  }

  async resolve(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }): Promise<ResolvedSetup> {
    if (!this.callback) return {};

    let result: SetupResult;
    try {
      result = (await this.callback(req)) || {};
    } catch {
      return {};
    }

    const { enrich, ...rest } = result;

    // Group identifier for caching — prefer projectId (coarse), fall back to
    // apiKey (fine-grained). That way multiple end-users from one project
    // share a cache slot.
    const cacheKey = rest.projectId || rest.apiKey;

    if (typeof enrich === "function" && cacheKey && !this.enrichCache.isFresh(cacheKey)) {
      try {
        const enriched = await enrich();
        this.enrichCache.markFresh(cacheKey);
        return { ...rest, _enriched: enriched };
      } catch {
        // Enrichment failure must not break the request path.
      }
    }

    return rest;
  }

  /**
   * Redact + truncate, then enqueue.
   */
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
    this.uploader.push(sanitized);
  }

  async flush() {
    await this.uploader.flush();
  }
}
