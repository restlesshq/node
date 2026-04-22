import type { CapturedRequest } from "../types.js";
import { toHarEntry } from "./har.js";

const DEFAULT_BASE_URL = "http://localhost:3003";
const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 5000;
/** Hard cap on the in-memory queue — prevents OOM during a metrics outage. */
const MAX_QUEUE = 1000;

/** Internal — values the engine passes into the uploader after resolving settings. */
export interface UploaderConfig {
  apiKey: string;
  baseUrl: string;
  requestIdPrefix?: string;
  fetchImpl?: typeof fetch;
  /** Called with the parsed server response body after a successful upload. */
  onResponse?: (body: unknown) => void;
}

function debugEnabled(): boolean {
  const flag = process.env.DEBUG || "";
  return flag === "restless" || flag.split(/[\s,]+/).includes("restless") || flag === "*";
}

export function resolveBaseUrl(explicit?: string): string {
  return explicit || process.env.RESTLESS_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * Batched uploader — pushes captured requests to `/v1/request` in batches.
 * Batching is hardcoded (10 / 5000ms); localhost flushes per-request.
 *
 * Never throws to callers — upload errors go to stderr under `DEBUG=restless`
 * and are otherwise swallowed. Observability must not break a request path.
 */
export class Uploader {
  private queue: CapturedRequest[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly prefix: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onResponse: UploaderConfig["onResponse"];

  constructor(cfg: UploaderConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl;
    this.prefix = cfg.requestIdPrefix;
    this.fetchImpl = cfg.fetchImpl || globalThis.fetch;
    this.onResponse = cfg.onResponse;

    // Warn (loudly, once) if the user has us shipping their project API key
    // over plain HTTP to somewhere that isn't localhost. The key + every
    // captured header would be transmitted in the clear.
    this.warnIfInsecure();
  }

  private warnIfInsecure() {
    try {
      const url = new URL(this.baseUrl);
      const isLocal =
        url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol === "http:" && !isLocal) {
        console.warn(
          `[@restlessai/sdk] RESTLESS_BASE_URL=${this.baseUrl} is plain HTTP — your API key and every captured header will be transmitted unencrypted. Use https:// or localhost.`,
        );
      }
    } catch {
      /* ignore */
    }
  }

  getOptions(): {
    baseUrl: string;
    requestIdPrefix: string | undefined;
  } {
    return { baseUrl: this.baseUrl, requestIdPrefix: this.prefix };
  }

  private isLocalhost(): boolean {
    try {
      const url = new URL(this.baseUrl);
      return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  }

  push(captured: CapturedRequest) {
    // Cap the queue so a metrics-server outage doesn't grow unbounded memory.
    // Drop oldest rather than newest — the newest entries are probably the
    // ones the operator is still actively debugging.
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      if (debugEnabled())
        console.warn(
          `[@restlessai/sdk] queue at ${MAX_QUEUE} — dropping oldest captured request`,
        );
    }
    this.queue.push(captured);

    // Dev ergonomics — on localhost, flush immediately so logs show up instantly.
    if (this.isLocalhost() || this.queue.length >= BATCH_SIZE) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    if (!this.apiKey) {
      if (debugEnabled())
        console.warn("[@restlessai/sdk] no API key — dropping batch");
      this.queue.length = 0;
      return;
    }

    const batch = this.queue.splice(0);

    const payload = batch.map((captured) => {
      const entry = toHarEntry(captured);
      const user = captured.user || {};
      const project = user.project;

      // Normalize email to an array on the wire — user API accepts either
      // string or string[], but the server gets a consistent shape.
      const rawEmail = project?.email;
      const emails = Array.isArray(rawEmail)
        ? rawEmail
        : rawEmail
        ? [rawEmail]
        : [];

      return {
        _id: captured.requestId,
        routePattern: captured.routePattern,
        // The primary grouping key. projectId if provided (so multiple
        // end-users within one project aggregate together), falling back
        // to the individual apiKey.
        group: {
          id: user.projectId || user.apiKey || "anonymous",
          label: project?.label || "",
          emails,
        },
        // Individual end-user fingerprint (separate from the grouping key).
        apiKey: user.apiKey,
        // Project ID carried separately so the server can index on it
        // independent of the group slot.
        projectId: user.projectId,
        clientIPAddress: "127.0.0.1",
        development: false,
        request: {
          log: {
            version: "1.2",
            creator: { name: "@restlessai/sdk", version: "0.2.0" },
            entries: [entry],
          },
        },
      };
    });

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/request`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        if (debugEnabled()) {
          console.error(
            `[@restlessai/sdk] upload failed: ${res.status} ${await res.text()}`,
          );
        }
        return;
      }
      // Pass the parsed response body up so the engine can react to
      // server-driven enrichment invalidation + similar signals.
      if (this.onResponse) {
        try {
          const body = await res.json();
          this.onResponse(body);
        } catch {
          /* non-JSON response is fine */
        }
      }
    } catch (err) {
      if (debugEnabled())
        console.error("[@restlessai/sdk] upload error:", err);
    }
  }
}
