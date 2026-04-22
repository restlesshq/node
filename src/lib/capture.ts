import type {
  CapturedRequest,
  SetupCallback,
  SetupResult,
  Project,
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

export const MAX_BODY_BYTES = 256 * 1024;

export interface EngineConfig extends Omit<UploaderConfig, "onResponse"> {
  defaultProject?: Project;
  redact?: RedactOptions;
}

/**
 * Shared capture engine. Adapters feed it raw request/response data; it
 * resolves setup callbacks (including lazy enrichment), applies redaction
 * + truncation, and hands the result to the uploader.
 */
export class CaptureEngine {
  readonly uploader: Uploader;
  readonly blocklist: Blocklist;
  readonly enrichCache: EnrichCache;
  private callback: SetupCallback | null = null;
  private defaultProject: Project | undefined;
  private redactOpts: RedactOptions;

  constructor(cfg: EngineConfig) {
    this.blocklist = new Blocklist();
    this.enrichCache = new EnrichCache();
    this.defaultProject = cfg.defaultProject;
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
   * Currently just handles `needsEnrichment: string[]` — masked keys the
   * server wants re-enriched on the next request.
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
  }): Promise<SetupResult> {
    const base: SetupResult = this.defaultProject
      ? { project: this.defaultProject }
      : {};
    if (!this.callback) return base;

    let result: SetupResult;
    try {
      result = (await this.callback(req)) || {};
    } catch {
      return base;
    }

    // Separate enrich() from the rest so we never leak a function into
    // the captured-request payload.
    const { enrich, ...rest } = result;

    // Decide whether to run enrich: we need a masked apiKey to cache under,
    // the enrich function must exist, and the key must be stale.
    if (
      typeof enrich === "function" &&
      typeof rest.apiKey === "string" &&
      !this.enrichCache.isFresh(rest.apiKey)
    ) {
      try {
        const enriched = await enrich();
        this.enrichCache.markFresh(rest.apiKey);
        return { ...base, ...rest, ...enriched };
      } catch {
        // Enrichment failure must not break the request path; the log still
        // ships without the extra metadata.
      }
    }

    return { ...base, ...rest };
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
