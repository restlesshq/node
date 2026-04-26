import type { CapturedRequest } from "../types.js";
import { toHarEntry } from "./har.js";

const DEFAULT_BASE_URL = "https://ingress.restless.ai";
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
 * Detect whether we're running inside a test harness. Uploads are disabled
 * in this mode by default so tests don't hammer real infrastructure.
 *
 * Covers the major runners. Mocha and Playwright don't set anything we
 * can key on — users in those environments should set `NODE_ENV=test`
 * themselves (which is already the recommended practice for both).
 */
function isTestRun(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VITEST === "true") return true;
  if (process.env.JEST_WORKER_ID !== undefined) return true;
  if (process.env.NODE_TEST_CONTEXT !== undefined) return true;
  if (process.env.AVA_PATH !== undefined) return true;
  return false;
}

function isLocalhostUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Decide whether to flush every push immediately or batch.
 *
 * Instant flush when:
 *   - `NODE_ENV !== 'production'` — customer developer loop, low volume
 *   - localhost baseUrl — self-hosted or SDK dev workflow
 *
 * Otherwise batch normally (10 per upload or 5s timer, whichever first).
 * `RESTLESS_SETUP_MODE` only gates the test-runner no-op in push(); it
 * does NOT force instant flush by itself (though during `npx api setup`
 * NODE_ENV is typically unset, which already triggers instant flush).
 */
function shouldFlushImmediately(baseUrl: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  if (isLocalhostUrl(baseUrl)) return true;
  return false;
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
    hasApiKey: boolean;
  } {
    return {
      baseUrl: this.baseUrl,
      requestIdPrefix: this.prefix,
      hasApiKey: !!this.apiKey,
    };
  }

  push(captured: CapturedRequest) {
    // Test runners: drop silently. Tests shouldn't hammer ingress. The
    // explicit `RESTLESS_SETUP_MODE=1` override re-enables uploads (the
    // CLI's test-curl step uses this).
    if (isTestRun() && process.env.RESTLESS_SETUP_MODE !== "1") {
      return;
    }

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

    if (
      shouldFlushImmediately(this.baseUrl) ||
      this.queue.length >= BATCH_SIZE
    ) {
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
        // Primary grouping key: project.id if provided (so multiple
        // end-users within one project aggregate together), falling back
        // to the individual apiKey.
        group: {
          id: project?.id || user.apiKey || "anonymous",
          label: project?.label || "",
          emails,
        },
        // Individual end-user fingerprint, separate from the grouping key.
        apiKey: user.apiKey,
        // Project id carried separately so the server can index on it
        // independent of the group slot.
        projectId: project?.id,
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

    const url = `${this.baseUrl}/v1/request`;
    if (debugEnabled()) {
      console.log(
        `[@restlessai/sdk] uploading ${batch.length} entr${batch.length === 1 ? "y" : "ies"} to ${url}`,
      );
    }
    try {
      const res = await this.fetchImpl(url, {
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
      if (debugEnabled()) {
        console.log(`[@restlessai/sdk] upload ok: ${res.status}`);
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
