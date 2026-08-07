import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientOptions } from "../types.js";
import restlessExpress from "./express.js";
import { makeAdapterClient, type AdapterClient } from "../lib/adapterFactory.js";
import { captureStateOf, type SetupHandle } from "./_shared.js";

/**
 * Bare Node http / Bun.serve-style adapter.
 *
 *     const restless = require('@restlessai/sdk/http')(process.env.RESTLESS_KEY);
 *     http.createServer(restless.setup(
 *       (req) => ({ ... }),
 *       (req, res) => myHandler(req, res),  // optional second arg: your handler
 *     ));
 *
 * `setup(cb)` returns a function `(handler) => nodeHttpListener` — call it
 * with your existing (req, res) handler to get a listener for `createServer`.
 */
type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
type HttpListenerBuilder = (handler: HttpHandler) => HttpHandler;

function buildHttpBuilder(handle: SetupHandle): HttpListenerBuilder {
  const mw = restlessExpress.middleware(handle);
  return (handler: HttpHandler) => {
    // Bare http has no error-handling layer: a handler that throws before
    // responding leaves res.end uncalled, so the capture middleware would
    // never fire and the crash - the request you most want a log for -
    // would produce nothing at all. Record it here instead, then re-throw
    // so the process sees exactly what it saw before (an unhandled
    // rejection); we add a log, we don't change the outcome.
    const invoke = async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await handler(req, res);
      } catch (err) {
        const state = captureStateOf(req);
        if (state) {
          state.error = err;
          state.recordThrow?.(err);
        }
        throw err;
      }
    };
    return (req: IncomingMessage, res: ServerResponse) => {
      mw(req, res, () => {
        void invoke(req, res);
      });
    };
  };
}

function restlessHttp(
  apiKey?: string,
  opts: ClientOptions = {},
): AdapterClient<HttpListenerBuilder> {
  return makeAdapterClient(apiKey, opts, (handle) => buildHttpBuilder(handle));
}

export default Object.assign(restlessHttp, { builder: buildHttpBuilder });
