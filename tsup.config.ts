import { defineConfig } from "tsup";

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
});
