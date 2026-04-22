import restless, { type RestlessClient } from "../index.js";
import type { ClientOptions, SetupCallback } from "../types.js";

/**
 * Shared "adapter client" factory — lets each framework export a one-liner
 * that builds a fully-configured client whose `.setup(cb)` returns middleware
 * directly.
 *
 *     const restless = require('@restlessai/sdk/express')(process.env.RESTLESS_KEY);
 *     app.use(restless.setup((req) => ({ ... })));
 *
 * The base `@restlessai/sdk` factory still exists for advanced users who want
 * a framework-less client.
 */
export interface AdapterClient<M> {
  /** Register a setup callback and get the framework middleware/plugin back. */
  setup(cb: SetupCallback): M;
  /** Mask an API key. Returns `undefined` for falsy input. */
  mask(apiKey: string | undefined | null): string | undefined;
  /** Force an upload of the queued batch. */
  flush(): Promise<void>;
  /** The underlying generic client, if you need low-level access. */
  client: RestlessClient;
}

/**
 * Build an adapter-specific client from an adapter function.
 *
 * @param buildMiddleware takes a setup handle and returns whatever the
 *   framework's register API wants (express middleware, fastify plugin,
 *   hono middleware, a next.js wrapper, ...).
 */
export function makeAdapterClient<M>(
  apiKey: string | undefined,
  opts: ClientOptions,
  buildMiddleware: (handle: {
    __restless: RestlessClient;
    __cb: SetupCallback;
  }) => M,
): AdapterClient<M> {
  const client = restless(apiKey, opts);
  return {
    client,
    mask: client.mask,
    flush: () => client.flush(),
    setup(cb) {
      const handle = client.setup(cb);
      return buildMiddleware(handle);
    },
  };
}
