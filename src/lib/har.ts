import type { CapturedRequest, HarEntry } from "../types.js";

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
