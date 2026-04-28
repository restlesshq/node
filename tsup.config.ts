import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/express.ts",
    "src/adapters/fastify.ts",
    "src/adapters/koa.ts",
    "src/adapters/hono.ts",
    "src/adapters/next.ts",
    "src/adapters/http.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  splitting: false,
  treeshake: true,
  external: ["fastify", "fastify-plugin", "koa", "hono", "next"],
  // Inline the package.json version at build time so the wire payload's
  // creator.version always matches the published artifact. See
  // src/lib/uploader.ts where __SDK_VERSION__ is consumed.
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
