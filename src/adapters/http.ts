import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientOptions } from "../types.js";
import type { SetupCallback } from "../types.js";
import restlessExpress from "./express.js";
import { makeAdapterClient, type AdapterClient } from "../lib/adapterFactory.js";
import type { SetupHandle } from "./_shared.js";

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
    return (req: IncomingMessage, res: ServerResponse) => {
      mw(req, res, () => {
        void handler(req, res);
      });
    };
  };
}

export default function restlessHttp(
  apiKey?: string,
  opts: ClientOptions = {},
): AdapterClient<HttpListenerBuilder> {
  return makeAdapterClient(apiKey, opts, (handle) => buildHttpBuilder(handle));
}
