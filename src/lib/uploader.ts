import type { CapturedRequest } from "../types.js";
import { toHarEntry } from "./har.js";
import { SPEC_VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://ingress.restless.ai";
const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 5000;
/** Hard cap on the in-memory queue — prevents OOM during a metrics outage. */
const MAX_QUEUE = 1000;
/** BATCH-009: concurrent uploads per client, so a slow ingest can't grow the host's memory. */
const MAX_IN_FLIGHT = 4;
/** BATCH-010: entries per upload once the queue has grown past BATCH_SIZE behind the cap. */
const MAX_UPLOAD_ENTRIES = 100;
/** WIRE-028: an upload that has not answered by now is abandoned (and not retried, WIRE-027). */
const UPLOAD_TIMEOUT_MS = 10_000;
/** WIRE-026: retries of a refused upload, and the ceiling on any single wait. */
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const MAX_RETRY_DELAY_MS = 10_000;
/** Connection failures where nothing reached the server, so a retry cannot duplicate. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** Internal — values the engine passes into the uploader after resolving settings. */
export interface UploaderConfig {
  apiKey: string;
  baseUrl: string;
  requestIdPrefix?: string;
  fetchImpl?: typeof fetch;
  /**
   * Hash of the sampling config (CONTRACT.md SAMPLE-040), stamped on every
   * upload as `x-restless-sampling` (SAMPLE-052). Absent when sampling is
   * not configured, and then no header is sent at all.
   */
  samplingHash?: string;
  /**
   * Called with the parsed server response body after a successful upload.
   * `batchFingerprints` is the deduplicated list of error fingerprint keys
   * the engine just uploaded; the engine uses it to negative-cache any
   * fingerprint the server didn't return a recovery message for.
   */
  onResponse?: (body: unknown, batchFingerprints: string[]) => void;
}

export function debugEnabled(): boolean {
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
export function isTestRun(): boolean {
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
 * does NOT force instant flush by itself (though during `npx restless init`
 * NODE_ENV is typically unset, which already triggers instant flush).
 */
function shouldFlushImmediately(baseUrl: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  if (isLocalhostUrl(baseUrl)) return true;
  return false;
}

/** WIRE-026: the server's Retry-After (seconds or an HTTP date), else jittered exponential backoff. */
function retryDelayMs(res: Response | undefined, retry: number): number {
  const header = res?.headers?.get?.("retry-after");
  let ms: number | undefined;
  if (header) {
    const seconds = Number(header);
    ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  }
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    ms = RETRY_BASE_MS * 2 ** retry * (0.5 + Math.random());
  }
  return Math.min(ms, MAX_RETRY_DELAY_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function notSent(err: unknown): boolean {
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
    (err as { code?: string })?.code;
  return typeof code === "string" && NOT_SENT_CODES.has(code);
}

/**
 * Batched uploader — pushes captured requests to `/v1/request` in batches.
 * Batching is hardcoded (10 / 5000ms); localhost flushes per-request. At most
 * MAX_IN_FLIGHT uploads run at once; behind that cap the queue keeps filling
 * (bounded by MAX_QUEUE) and each freed slot sends up to MAX_UPLOAD_ENTRIES.
 *
 * Never throws to callers — upload errors go to stderr under `DEBUG=restless`
 * and are otherwise swallowed. Observability must not break a request path.
 */
export class Uploader {
  private queue: CapturedRequest[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly prefix: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onResponse: UploaderConfig["onResponse"];
  private readonly samplingHash: string | undefined;

  constructor(cfg: UploaderConfig) {
    this.samplingHash = cfg.samplingHash;
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

    if (shouldFlushImmediately(this.baseUrl)) {
      this.pump(true);
    } else if (this.queue.length >= BATCH_SIZE) {
      this.pump(false);
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump(true);
      }, FLUSH_INTERVAL_MS);
    }
  }

  /** Uploads everything queued, at most MAX_IN_FLIGHT at a time, and resolves when all of it settles. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length || this.inFlight.size) {
      this.pump(true);
      if (!this.inFlight.size) break; // no API key: pump dropped the queue (BATCH-007)
      await Promise.race(this.inFlight);
    }
  }

  /**
   * Starts uploads while a slot is free. `partial` sends a batch smaller than
   * BATCH_SIZE (timer, explicit flush, dev/localhost); otherwise only full
   * batches go, and a remainder waits for the timer.
   */
  private pump(partial: boolean) {
    if (!this.apiKey) {
      if (this.queue.length && debugEnabled())
        console.warn("[@restlessai/sdk] no API key — dropping batch");
      this.queue.length = 0;
      return;
    }
    while (
      this.inFlight.size < MAX_IN_FLIGHT &&
      this.queue.length > 0 &&
      (partial || this.queue.length >= BATCH_SIZE)
    ) {
      const batch = this.queue.splice(0, MAX_UPLOAD_ENTRIES);
      // SAFETY-001/004: an upload never rejects into the host, whatever send() hits.
      const upload: Promise<void> = this.send(batch)
        .catch((err) => {
          if (debugEnabled()) console.error("[@restlessai/sdk] upload error:", err);
        })
        .finally(() => {
          this.inFlight.delete(upload);
          this.afterUpload();
        });
      this.inFlight.add(upload);
    }
  }

  /** A slot freed up: send what is waiting, or make sure a remainder still has a timer. */
  private afterUpload() {
    if (!this.queue.length) return;
    if (shouldFlushImmediately(this.baseUrl) || this.queue.length >= BATCH_SIZE) {
      this.pump(shouldFlushImmediately(this.baseUrl));
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump(true);
      }, FLUSH_INTERVAL_MS);
    }
  }

  private buildPayload(batch: CapturedRequest[]) {
    return batch.map((captured) => {
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
        errorFingerprint: captured.errorFingerprint,
        // Present only on a stub (WIRE-030); `undefined` drops the key.
        sampled: captured.sampled ? true : undefined,
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
            creator: { name: "@restlessai/sdk", version: __SDK_VERSION__ },
            entries: [entry],
          },
        },
      };
    });
  }

  /**
   * One upload, holding its slot through any retries. Retries only what the
   * ingest certainly did not store (WIRE-026/027): 429, 503, or a connection
   * that never reached it. A 502/504 or timeout may have been stored, and a
   * resend would duplicate it, so those are dropped like any other failure.
   */
  private async send(batch: CapturedRequest[]): Promise<void> {
    // Unique fingerprint keys in this batch. Passed to onResponse so the
    // engine can negative-cache anything the server didn't return a
    // recovery message for.
    const batchFingerprints: string[] = [];
    {
      const seen = new Set<string>();
      for (const c of batch) {
        const k = c.errorFingerprint?.key;
        if (k && !seen.has(k)) {
          seen.add(k);
          batchFingerprints.push(k);
        }
      }
    }

    const body = JSON.stringify(this.buildPayload(batch));
    const url = `${this.baseUrl}/v1/request`;

    for (let retry = 0; ; retry += 1) {
      if (debugEnabled()) {
        console.log(
          `[@restlessai/sdk] uploading ${batch.length} entr${batch.length === 1 ? "y" : "ies"} to ${url}${retry ? ` (retry ${retry})` : ""}`,
        );
      }
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            // Which contract version produced this payload. The ingest
            // ignores it today; it exists so an off-contract payload can be
            // attributed to an SDK + spec version instead of guessed at.
            // See spec/CONTRACT.md META-002.
            "X-Restless-Spec-Version": SPEC_VERSION,
            ...(this.samplingHash
              ? { "x-restless-sampling": this.samplingHash }
              : {}),
          },
          body,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        if (notSent(err) && retry < MAX_RETRIES) {
          await sleep(retryDelayMs(undefined, retry));
          continue;
        }
        if (debugEnabled())
          console.error("[@restlessai/sdk] upload error:", err);
        return;
      }

      if (!res.ok) {
        if ((res.status === 503 || res.status === 429) && retry < MAX_RETRIES) {
          const wait = retryDelayMs(res, retry);
          if (debugEnabled())
            console.warn(
              `[@restlessai/sdk] upload refused (${res.status}); retrying in ${Math.round(wait)}ms`,
            );
          await sleep(wait);
          continue;
        }
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
          const parsed = await res.json();
          this.onResponse(parsed, batchFingerprints);
        } catch {
          /* non-JSON response is fine */
        }
      }
      return;
    }
  }

  /**
   * POST the sampling config report (CONTRACT.md SAMPLE-050). Same gates as
   * an upload: nothing under a test runner or without a project key
   * (SAMPLE-051). Resolves `true` only on a 2xx; never throws.
   */
  async sendSamplingReport(report: unknown): Promise<boolean> {
    if (isTestRun() && process.env.RESTLESS_SETUP_MODE !== "1") return false;
    if (!this.apiKey) return false;
    const url = `${this.baseUrl}/v1/sampling`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Restless-Spec-Version": SPEC_VERSION,
        },
        body: JSON.stringify(report),
      });
      if (debugEnabled()) {
        console.log(`[@restlessai/sdk] sampling report: ${res.status}`);
      }
      return res.ok;
    } catch (err) {
      if (debugEnabled())
        console.error("[@restlessai/sdk] sampling report error:", err);
      return false;
    }
  }
}
