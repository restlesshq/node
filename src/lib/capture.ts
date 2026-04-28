import type {
  CapturedRequest,
  ProjectDetails,
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

export const MAX_BODY_BYTES = 256 * 1024;

export interface EngineConfig extends Omit<UploaderConfig, "onResponse"> {
  redact?: RedactOptions;
}

/** Shape `engine.resolve()` returns — the setup result with project merged + enriched. */
export interface ResolvedSetup {
  apiKey?: string;
  project?: ProjectDetails & { id?: string };
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
   * Server can respond with `{ needsEnrichment: [<projectId>...] }` to force
   * re-running `enrich` on the next request from that project.
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

    const { project: rawProject, ...rest } = result;
    if (!rawProject) {
      // No project → just apiKey + anything else
      return rest as ResolvedSetup;
    }

    const { enrich, ...inlineProject } = rawProject;
    const cacheKey = rawProject.id || rest.apiKey;

    // We cache the enriched VALUE (not just a freshness marker) so
    // every upload carries user metadata, even when we skip running
    // the (potentially expensive) enrich callback. Without this every
    // request after the first would land in the dashboard as
    // "unauthenticated", since the server has no way to backfill.
    if (typeof enrich === "function" && rawProject.id && cacheKey) {
      const cached = this.enrichCache.get(cacheKey);
      if (cached) {
        return {
          ...rest,
          project: { ...inlineProject, ...cached },
        } as ResolvedSetup;
      }
      try {
        const enriched = await enrich(rawProject.id);
        if (enriched && typeof enriched === "object") {
          this.enrichCache.set(cacheKey, enriched as Record<string, unknown>);
          return {
            ...rest,
            project: { ...inlineProject, ...enriched },
          } as ResolvedSetup;
        }
      } catch {
        // Enrichment failure must not break the request path.
      }
    }

    return { ...rest, project: inlineProject } as ResolvedSetup;
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
    this.uploader.push(sanitized);
  }

  async flush() {
    await this.uploader.flush();
  }
}
