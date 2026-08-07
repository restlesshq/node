import type { CapturedRequest, HarEntry } from "../types.js";
import { percentDecode } from "./redact.js";

/**
 * Serialize an already-parsed request body for capture, defensively.
 *
 * Adapters that read the framework's parsed body (Fastify `req.body`, Koa
 * `ctx.request.body`) can be handed values that `JSON.stringify` refuses:
 * `@fastify/multipart` with `attachFieldsToBody` gives each file a `.fields`
 * back-pointer, so the body is circular and `JSON.stringify` throws
 * `TypeError: Converting circular structure to JSON`. In Fastify that throw
 * lands inside the `onSend` hook and 500s the request — i.e. observability
 * breaking the request path, which the SDK guarantees it never does.
 *
 * So: pass strings through untouched, skip multipart bodies (a stringified
 * parsed multipart body is meaningless anyway), and swallow any other
 * stringify failure down to `undefined` rather than throwing.
 */
export function safeStringifyReqBody(
  body: unknown,
  contentType?: string,
): string | undefined {
  if (typeof body === "string") return body;
  if (!body) return undefined;
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("multipart/form-data")) return undefined;
  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}

/**
 * Size of a string in UTF-8 BYTES, which is what HAR's `bodySize` /
 * `content.size` are defined to mean. We previously reported `.length`
 * (UTF-16 code units), which is wrong in JS and a different kind of wrong
 * in every port. See spec/CONTRACT.md HAR-010.
 */
function utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function headersToList(
  headers: Record<string, string>,
): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/**
 * Parse the query into ordered name/value pairs (HAR-005).
 *
 * Hand-rolled rather than delegating to `URL.searchParams` so it shares the
 * exact decoding rule with `redactUrl` and so a port does not have to
 * reproduce WHATWG URL parsing to agree with us. Duplicate names are
 * preserved, which a dict-based parse would lose.
 */
function parseQueryString(
  url: string,
): Array<{ name: string; value: string }> {
  const q = url.indexOf("?");
  if (q === -1) return [];
  const rest = url.slice(q + 1);
  const hash = rest.indexOf("#");
  const query = hash === -1 ? rest : rest.slice(0, hash);
  if (!query) return [];

  const out: Array<{ name: string; value: string }> = [];
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) out.push({ name: percentDecode(pair), value: "" });
    else
      out.push({
        name: percentDecode(pair.slice(0, eq)),
        value: percentDecode(pair.slice(eq + 1)),
      });
  }
  return out;
}

export function toHarEntry(captured: CapturedRequest): HarEntry {
  const reqContentType = captured.request.headers["content-type"] || "";
  const resContentType =
    captured.response.headers["content-type"] || "application/octet-stream";

  return {
    startedDateTime: captured.startedAt,
    time: captured.duration,
    request: {
      method: captured.request.method,
      url: captured.request.url,
      httpVersion: "HTTP/1.1",
      headers: headersToList(captured.request.headers),
      queryString: parseQueryString(captured.request.url),
      ...(captured.request.body
        ? { postData: { mimeType: reqContentType, text: captured.request.body } }
        : {}),
      headersSize: -1,
      bodySize:
        captured.request.body === undefined
          ? -1
          : utf8Len(captured.request.body),
    },
    response: {
      status: captured.response.status,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: headersToList(captured.response.headers),
      content: {
        size:
          captured.response.body === undefined
            ? 0
            : utf8Len(captured.response.body),
        mimeType: resContentType,
        text: captured.response.body ?? "",
      },
      headersSize: -1,
      bodySize:
        captured.response.body === undefined
          ? -1
          : utf8Len(captured.response.body),
    },
    timings: { send: 0, wait: captured.duration, receive: 0 },
  };
}
