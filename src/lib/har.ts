import type { CapturedRequest, HarEntry } from "../types.js";

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

function headersToList(
  headers: Record<string, string>,
): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function parseQueryString(
  url: string,
): Array<{ name: string; value: string }> {
  try {
    const parsed = new URL(url, "http://localhost");
    return [...parsed.searchParams.entries()].map(([name, value]) => ({
      name,
      value,
    }));
  } catch {
    return [];
  }
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
      bodySize: captured.request.body?.length ?? -1,
    },
    response: {
      status: captured.response.status,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: headersToList(captured.response.headers),
      content: {
        size: captured.response.body?.length ?? 0,
        mimeType: resContentType,
        text: captured.response.body ?? "",
      },
      headersSize: -1,
      bodySize: captured.response.body?.length ?? -1,
    },
    timings: { send: 0, wait: captured.duration, receive: 0 },
  };
}
