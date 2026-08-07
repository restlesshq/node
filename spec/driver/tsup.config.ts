import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

/**
 * Builds the Node conformance driver into `spec/driver/.build/`.
 *
 * Kept out of the main tsup config on purpose: `files: ["dist", ...]` in
 * package.json ships everything under `dist/`, and the driver is a dev
 * tool that has no business in the published tarball.
 */
export default defineConfig({
  entry: ["spec/driver/node.ts"],
  outDir: "spec/driver/.build",
  format: ["esm"],
  target: "node18",
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
