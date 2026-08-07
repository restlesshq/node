import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * Guards the shape of the built CommonJS artifacts.
 *
 * Every other test in this suite imports from `src/` through TypeScript, so
 * none of them can see this: the documented CJS entry points are only
 * produced by the build, and their shape is decided by esbuild's interop
 * rules rather than by anything visible in the source.
 *
 * The rule that bites: a module with ONLY a default export compiles to
 * `module.exports = fn`, so `require(...)` is directly callable. Add a single
 * named export alongside it and esbuild switches to
 * `module.exports = { default: fn, ...named }`, which silently breaks
 *
 *     const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY);
 *
 * the first snippet in the README. This happened: adding `errorHandler`,
 * `SPEC_VERSION` and `buildHttpBuilder` as named exports broke `index`,
 * `express` and `http` at once. Every unit test still passed, and it was
 * caught only by running a real app against the built package.
 *
 * So: anything that needs to be reachable from a callable entry point is
 * attached to the default export (`Object.assign(fn, { ... })`), never
 * exported by name from the entry module itself. Helpers that want named
 * exports live in a non-entry module such as `adapters/_shared.ts`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const require_ = createRequire(import.meta.url);

/**
 * `next` is deliberately an object: it is documented with named imports
 * (`import { withRestless } from '@restlessai/sdk/next'`), and it has no
 * single callable identity.
 */
const CALLABLE = [
  ["index", "dist/index.cjs"],
  ["express", "dist/adapters/express.cjs"],
  ["fastify", "dist/adapters/fastify.cjs"],
  ["koa", "dist/adapters/koa.cjs"],
  ["hono", "dist/adapters/hono.cjs"],
  ["http", "dist/adapters/http.cjs"],
] as const;

const built = existsSync(join(DIST, "index.cjs"));

describe.skipIf(!built)("built CJS entry points", () => {
  beforeAll(() => {
    // A stale dist is worse than none: it would assert the shape of an old
    // build and pass while the current source is broken.
    expect(
      built,
      "dist/ is missing. Run `npm run build` before this suite, as CI does.",
    ).toBe(true);
  });

  for (const [name, rel] of CALLABLE) {
    it(`require('@restlessai/sdk${name === "index" ? "" : "/" + name}') is callable`, () => {
      const mod = require_(join(HERE, "..", rel));
      expect(
        typeof mod,
        `${rel} exports a ${typeof mod}, not a function. Something in that ` +
          `entry module gained a named export; attach it to the default with ` +
          `Object.assign instead.`,
      ).toBe("function");
    });
  }

  it("the client factory still returns a usable client", () => {
    // Callable is necessary but not sufficient: prove the thing you get back
    // is the documented client, not some other function.
    const restless = require_(join(HERE, "..", "dist/index.cjs"));
    const client = restless("test_key");
    expect(typeof client.setup).toBe("function");
    expect(typeof client.mask).toBe("function");
    expect(typeof client.flush).toBe("function");
  });

  it("helpers attached to the default are reachable through require()", () => {
    // Because module.exports IS the function, properties hung off it survive.
    const restless = require_(join(HERE, "..", "dist/index.cjs"));
    expect(typeof restless.mask).toBe("function");
    expect(typeof restless.errorHandler).toBe("function");
    expect(restless.SPEC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("express exposes errorHandler for the documented registration", () => {
    const restlessExpress = require_(join(HERE, "..", "dist/adapters/express.cjs"));
    expect(typeof restlessExpress.errorHandler).toBe("function");
  });

  it("next is an object, exposing withRestless by name", () => {
    const next = require_(join(HERE, "..", "dist/adapters/next.cjs"));
    expect(typeof next).toBe("object");
    expect(typeof next.withRestless).toBe("function");
  });
});
