import { describe, test, expectTypeOf } from "vitest";
import restlessNext, {
  wrapRouteHandler,
  defineConfig,
  type RestlessNextConfig,
} from "../src/adapters/next.js";

/**
 * Compile-only type fixture for the Next.js adapter.
 *
 * Regression guard for the `strictFunctionTypes` contravariance bug: an App
 * Router handler typed with `NextRequest` used to be rejected by the wrapper
 * because the old constraint typed `req` as the supertype `Request`. See
 * src/adapters/next.ts. These assignments must COMPILE; the assertions pin the
 * wrapper to identity-over-the-handler so each route's exact signature (its
 * NextRequest and async `{ params }` context) survives for Next's generated
 * route type-checker. Run with `vitest --typecheck` (see vitest.config.ts).
 *
 * `next` is a peer dependency and isn't installed here, so we use a minimal
 * structural stand-in that reproduces the exact subtype relationship:
 * NextRequest extends the global Request and adds the fields App Router
 * handlers read (cookies, nextUrl, page, ua).
 */
interface NextRequest extends Request {
  readonly cookies: { get(name: string): { value: string } | undefined };
  readonly nextUrl: URL;
  readonly page?: unknown;
  readonly ua?: unknown;
}

// Both entry points the fix must support: the adapter client's `setup(cb)`
// return value and the exported `wrap` (used internally by the universal
// dispatcher). Both are the same `<T extends NextHandler>(handler: T) => T`.
const client = restlessNext("rdme_key");
const withRestless = client.setup(() => ({ apiKey: "k" }));
type Wrap = ReturnType<typeof restlessNext.wrap>;
declare const wrap: Wrap;

// 1. A NextRequest App Router handler (reads req.nextUrl).
async function getHandler(req: NextRequest): Promise<Response> {
  return new Response(req.nextUrl.pathname);
}
export const GET = withRestless(getHandler);

// 2. NextRequest + async `{ params }` second arg (Next 15 route context).
async function slugHandler(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  return new Response(`${slug}:${req.nextUrl.href}`);
}
export const POST = withRestless(slugHandler);

// 3. A plain (req: Request) => Response handler — must not regress.
function plainHandler(req: Request): Response {
  return new Response(req.url);
}
export const PUT = withRestless(plainHandler);

describe("next adapter typing (compile-only)", () => {
  test("wrap is identity over the handler's exact signature", () => {
    // The wrapper returns the handler's own type T — not a widened one — so
    // Next's generated `.next/types` route checker sees the real signature.
    expectTypeOf(withRestless(getHandler)).toEqualTypeOf<typeof getHandler>();
    expectTypeOf(withRestless(slugHandler)).toEqualTypeOf<
      typeof slugHandler
    >();
    expectTypeOf(withRestless(plainHandler)).toEqualTypeOf<
      typeof plainHandler
    >();
  });

  test("the exported wrap accepts the same handlers with no cast", () => {
    expectTypeOf(wrap(getHandler)).toEqualTypeOf<typeof getHandler>();
    expectTypeOf(wrap(slugHandler)).toEqualTypeOf<typeof slugHandler>();
    expectTypeOf(wrap(plainHandler)).toEqualTypeOf<typeof plainHandler>();
  });

  test("exported route consts keep their handler types", () => {
    expectTypeOf(GET).toEqualTypeOf<typeof getHandler>();
    expectTypeOf(POST).toEqualTypeOf<typeof slugHandler>();
    expectTypeOf(PUT).toEqualTypeOf<typeof plainHandler>();
  });
});

describe("wrapRouteHandler typing (compile-only)", () => {
  const config = defineConfig({
    setup: (req) => {
      // The setup callback receives the web Request.
      expectTypeOf(req).toEqualTypeOf<Request>();
      return { apiKey: "k" };
    },
  });

  test("identity over the handler's exact signature, same as wrap", () => {
    expectTypeOf(wrapRouteHandler(getHandler, config, "GET")).toEqualTypeOf<
      typeof getHandler
    >();
    expectTypeOf(wrapRouteHandler(slugHandler, config)).toEqualTypeOf<
      typeof slugHandler
    >();
    expectTypeOf(wrapRouteHandler(plainHandler)).toEqualTypeOf<
      typeof plainHandler
    >();
  });

  test("undefined passes through as undefined (facade absent-method case)", () => {
    expectTypeOf(wrapRouteHandler(undefined, config, "GET")).toEqualTypeOf<
      undefined
    >();
  });

  test("defineConfig is identity over RestlessNextConfig", () => {
    expectTypeOf(config).toEqualTypeOf<RestlessNextConfig>();
  });

  test("setup accepts a NextRequest-typed callback (bivariance regression guard)", () => {
    // Real-world configs type the param as NextRequest to read req.nextUrl.
    // `setup` is declared as a method so this stays assignable under
    // strictFunctionTypes; an arrow-property declaration would reject it.
    defineConfig({
      setup: async (req: NextRequest) => ({
        apiKey: req.nextUrl.searchParams.get("key") ?? undefined,
      }),
    });
    // Untyped params still contextually infer the web Request.
    defineConfig({
      setup: (req) => {
        expectTypeOf(req).toEqualTypeOf<Request>();
        return {};
      },
    });
  });
});
