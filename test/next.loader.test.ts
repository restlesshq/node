import { describe, it, expect, vi } from "vitest";
import ts from "typescript";
import restlessLoader, {
  type RestlessLoaderOptions,
} from "../src/adapters/next-loader.js";

/**
 * Codegen tests for the withRestless wrapping loader. The loader is a plain
 * string-in/string-out function; we drive it with a fake loader context.
 */

const ROOT = "/proj";

function runLoader(
  source: string,
  {
    resourcePath = `${ROOT}/app/api/hello/route.ts`,
    resourceQuery = "",
    options = {},
  }: {
    resourcePath?: string;
    resourceQuery?: string;
    options?: Partial<RestlessLoaderOptions>;
  } = {},
) {
  const warnings: string[] = [];
  const ctx = {
    resourcePath,
    resourceQuery,
    getOptions: (): RestlessLoaderOptions => ({
      projectRoot: ROOT,
      configPath: `${ROOT}/restless.config.ts`,
      ...options,
    }),
    emitWarning: (err: Error) => warnings.push(err.message),
  };
  const output = restlessLoader.call(ctx, source);
  return { output, warnings };
}

const BASIC = `
import { NextRequest } from "next/server";
export async function GET(req: NextRequest) {
  return Response.json({ ok: true });
}
export const POST = async () => new Response(null, { status: 201 });
`;

describe("facade codegen", () => {
  it("wraps detected methods and imports the config relatively", () => {
    const { output, warnings } = runLoader(BASIC);
    expect(warnings).toEqual([]);
    expect(output).toContain(
      'import * as __restless_orig from "./route.ts?__restless_original__";',
    );
    expect(output).toContain(
      'import * as __restless_cfgmod from "../../../restless.config.ts";',
    );
    expect(output).toContain(
      'import { wrapRouteHandler as __restless_wrap } from "@restlessai/sdk/next";',
    );
    expect(output).toContain(
      'export const GET = __restless_wrap(__restless_orig.GET, __restless_cfg, "GET");',
    );
    expect(output).toContain(
      'export const POST = __restless_wrap(__restless_orig.POST, __restless_cfg, "POST");',
    );
    // Only detected methods are emitted.
    expect(output).not.toContain("__restless_orig.PUT");
    // Never a star or default re-export.
    expect(output).not.toContain("export *");
    expect(output).not.toContain("export default");
  });

  it("re-exports segment config concretely, never via export *", () => {
    const source = `${BASIC}
export const dynamic = "force-dynamic";
export const revalidate = 60;
export function generateStaticParams() { return []; }
`;
    const { output } = runLoader(source);
    expect(output).toContain(
      'export { dynamic } from "./route.ts?__restless_original__";',
    );
    expect(output).toContain(
      'export { revalidate } from "./route.ts?__restless_original__";',
    );
    expect(output).toContain(
      'export { generateStaticParams } from "./route.ts?__restless_original__";',
    );
  });

  it("emits a zero-config facade when no configPath was discovered", () => {
    const { output } = runLoader(BASIC, {
      options: { configPath: undefined },
    });
    expect(output).not.toContain("__restless_cfgmod");
    expect(output).toContain("const __restless_cfg = undefined;");
    expect(output).toContain("__restless_wrap(__restless_orig.GET");
  });

  it("emits valid TS/JS (transpiles cleanly, output parses)", () => {
    const { output } = runLoader(BASIC);
    const transpiled = ts.transpileModule(output, {
      compilerOptions: { module: ts.ModuleKind.ESNext, strict: true },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics).toEqual([]);
  });

  it("normalizes Windows-style paths in emitted specifiers", () => {
    const { output } = runLoader(BASIC, {
      resourcePath: `${ROOT}/app/api/hello/route.ts`,
      options: { configPath: `${ROOT}/restless.config.ts` },
    });
    expect(output).not.toContain("\\\\");
  });
});

describe("export detection", () => {
  const CASES: Array<[string, string, string[]]> = [
    ["async function", "export async function GET(req) {}", ["GET"]],
    ["function", "export function DELETE() {}", ["DELETE"]],
    ["const arrow", "export const PATCH = async () => new Response()", ["PATCH"]],
    ["let", "export let PUT = handler", ["PUT"]],
    ["export list", "function a() {}\nexport { a as GET, b as POST }", ["GET", "POST"]],
    ["re-export from", 'export { GET, POST } from "./impl"', ["GET", "POST"]],
    ["destructured", "export const { GET, HEAD } = handlers", ["GET", "HEAD"]],
    [
      "multiple styles mixed",
      'export async function GET() {}\nexport { handler as OPTIONS } from "./impl"',
      ["GET", "OPTIONS"],
    ],
  ];

  for (const [label, source, expected] of CASES) {
    it(`detects: ${label}`, () => {
      const { output } = runLoader(source);
      for (const method of expected) {
        expect(output, `${label} should wrap ${method}`).toContain(
          `__restless_orig.${method}`,
        );
      }
    });
  }

  it("ignores methods that only appear in comments or strings", () => {
    const source = `
// export function POST() {} — docs, not code
/* export const PUT = x */
const help = "export function DELETE() {}";
export async function GET() { return new Response(help); }
`;
    const { output } = runLoader(source);
    expect(output).toContain("__restless_orig.GET");
    expect(output).not.toContain("__restless_orig.POST");
    expect(output).not.toContain("__restless_orig.PUT");
    expect(output).not.toContain("__restless_orig.DELETE");
  });

  it("ignores type-only export lists", () => {
    const source = `
export type { GET } from "./types";
export async function POST() { return new Response(); }
`;
    const { output } = runLoader(source);
    expect(output).not.toContain("__restless_orig.GET");
    expect(output).toContain("__restless_orig.POST");
  });
});

describe("pass-through cases", () => {
  it("returns the original-module request untouched (recursion guard)", () => {
    const { output } = runLoader(BASIC, {
      resourceQuery: "?__restless_original__",
    });
    expect(output).toBe(BASIC);
  });

  it("is idempotent on its own facade output", () => {
    const { output: first } = runLoader(BASIC);
    const { output: second } = runLoader(first);
    expect(second).toBe(first);
  });

  it("skips files outside (src/)app under the project root", () => {
    for (const resourcePath of [
      `${ROOT}/lib/route.ts`,
      `${ROOT}/node_modules/pkg/app/api/route.ts`,
      `/elsewhere/app/api/route.ts`,
    ]) {
      const { output } = runLoader(BASIC, { resourcePath });
      expect(output, resourcePath).toBe(BASIC);
    }
    // src/app IS wrapped.
    const { output } = runLoader(BASIC, {
      resourcePath: `${ROOT}/src/app/api/hello/route.ts`,
    });
    expect(output).toContain("__restless_wrap");
  });

  it("skips non-route files and non-configured extensions", () => {
    const { output } = runLoader(BASIC, {
      resourcePath: `${ROOT}/app/api/hello/handlers.ts`,
    });
    expect(output).toBe(BASIC);
    const { output: mdRoute } = runLoader(BASIC, {
      resourcePath: `${ROOT}/app/api/hello/route.mjs`,
    });
    expect(mdRoute).toBe(BASIC);
    // Custom pageExtensions widen the match.
    const { output: custom } = runLoader(BASIC, {
      resourcePath: `${ROOT}/app/api/hello/route.mts`,
      options: { exts: ["mts", "ts"] },
    });
    expect(custom).toContain("__restless_wrap");
  });

  it("honors exclude globs against the root-relative path", () => {
    const opts = { exclude: ["app/api/health/**", "**/internal/*"] };
    const { output: excluded } = runLoader(BASIC, {
      resourcePath: `${ROOT}/app/api/health/route.ts`,
      options: opts,
    });
    expect(excluded).toBe(BASIC);
    const { output: alsoExcluded } = runLoader(BASIC, {
      resourcePath: `${ROOT}/app/api/internal/route.ts`,
      options: opts,
    });
    expect(alsoExcluded).toBe(BASIC);
    const { output: wrapped } = runLoader(BASIC, {
      resourcePath: `${ROOT}/app/api/hello/route.ts`,
      options: opts,
    });
    expect(wrapped).toContain("__restless_wrap");
  });

  it("include allowlist wraps only matching route files", () => {
    const opts = { include: ["app/api/v1/**"] };
    const { output: wrapped } = runLoader(BASIC, {
      resourcePath: `${ROOT}/app/api/v1/me/route.ts`,
      options: opts,
    });
    expect(wrapped).toContain("__restless_wrap");
    for (const resourcePath of [
      `${ROOT}/app/api/internal/route.ts`,
      `${ROOT}/app/healthz/route.ts`,
    ]) {
      const { output } = runLoader(BASIC, { resourcePath, options: opts });
      expect(output, resourcePath).toBe(BASIC);
    }
  });

  it("include/exclude globs match with or without the src/ prefix", () => {
    // `app/...` glob matches a src/app layout...
    const { output: srcLayout } = runLoader(BASIC, {
      resourcePath: `${ROOT}/src/app/api/v1/me/route.ts`,
      options: { include: ["app/api/v1/**"] },
    });
    expect(srcLayout).toContain("__restless_wrap");
    // ...and a `src/app/...` glob matches too.
    const { output: explicit } = runLoader(BASIC, {
      resourcePath: `${ROOT}/src/app/api/v1/me/route.ts`,
      options: { include: ["src/app/api/v1/**"] },
    });
    expect(explicit).toContain("__restless_wrap");
    // Same normalization for exclude.
    const { output: excluded } = runLoader(BASIC, {
      resourcePath: `${ROOT}/src/app/api/health/route.ts`,
      options: { exclude: ["app/api/health/**"] },
    });
    expect(excluded).toBe(BASIC);
  });

  it("exclude wins over include on overlap", () => {
    const { output } = runLoader(BASIC, {
      resourcePath: `${ROOT}/app/api/v1/internal/route.ts`,
      options: {
        include: ["app/api/v1/**"],
        exclude: ["app/api/v1/internal/**"],
      },
    });
    expect(output).toBe(BASIC);
  });

  it("honors the restless-disable escape comment", () => {
    for (const comment of [
      "// restless-disable",
      "// @restless-disable",
      "/* restless disable */",
    ]) {
      const source = `${comment}\n${BASIC}`;
      const { output } = runLoader(source);
      expect(output, comment).toBe(source);
    }
  });

  it("skips edge-runtime routes with a warning", () => {
    for (const decl of [
      `export const runtime = "edge";`,
      `export const runtime = 'experimental-edge';`,
      `export const runtime: string = "edge";`,
    ]) {
      const source = `${BASIC}\n${decl}`;
      const { output, warnings } = runLoader(source);
      expect(output, decl).toBe(source);
      expect(warnings[0], decl).toContain("edge runtime");
    }
    // Node runtime is still wrapped.
    const { output } = runLoader(`${BASIC}\nexport const runtime = "nodejs";`);
    expect(output).toContain("__restless_wrap");
  });

  it("punts on export * with a warning", () => {
    const source = `export * from "./shared-handlers";`;
    const { output, warnings } = runLoader(source);
    expect(output).toBe(source);
    expect(warnings[0]).toContain("export *");
  });

  it("passes through files with no HTTP method exports", () => {
    const source = `export const dynamic = "force-dynamic";`;
    const { output, warnings } = runLoader(source);
    expect(output).toBe(source);
    expect(warnings).toEqual([]);
  });
});

describe("built artifact interop", () => {
  it("debug option logs decisions instead of warning", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      runLoader(BASIC, { options: { debug: true } });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("wrap: app/api/hello/route.ts"),
      );
    } finally {
      log.mockRestore();
    }
  });
});
